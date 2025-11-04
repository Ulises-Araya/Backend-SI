const { EventEmitter } = require('events');

const DEFAULT_CONFIG = {
  lanes: ['north', 'west', 'south', 'east'],
  sensorMap: {
    sensor1: 'east',
    sensor2: 'south',
    sensor3: 'north',
    sensor4: 'west',
  },
  detectionThresholdCm: Number(process.env.DETECTION_THRESHOLD_CM || 13.6),
  presenceTimeoutMs: Number(process.env.PRESENCE_TIMEOUT_MS || 10_000),
  minGreenMs: Number(process.env.MIN_GREEN_MS || 8_000),
  maxGreenMs: Number(process.env.MAX_GREEN_MS || 20_000),
  yellowMs: Number(process.env.YELLOW_MS || 3_000),
  maxRedMs: Number(process.env.MAX_RED_MS || 60_000),
  holdAfterClearMs: Number(process.env.HOLD_AFTER_CLEAR_MS || 2_000),
  vehiclePresenceGraceMs: Number(
    process.env.VEHICLE_GAP_HOLD_MS ||
    process.env.VEHICLE_PRESENCE_GRACE_MS ||
    4_000,
  ),
};

class TrafficController extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stateByLane = new Map();
    this.eventQueue = [];
    this._pendingPresenceEvents = [];
    this.nextLaneId = null;
    this.reset();
  }

  _createInitialLaneState(laneId, isGreen, now) {
    return {
      id: laneId,
      state: isGreen ? 'green' : 'red',
      lastChangeAt: now,
      lastVehicleAt: null,
      lastSampleAt: null,
      lastDistanceCm: null,
      isOccupied: false,
      lastClearedAt: null,
      redSince: isGreen ? null : now,
      cyclesCompleted: 0,
      waiting: false,
      presenceStartedAt: null,
      presenceTriggeredChange: false,
    };
  }

  ingestEvent({
    deviceId,
    intersectionId = 'default',
    sensors = {},
    timestamp = Date.now(),
    processedAt = Date.now(),
  }) {
    if (!deviceId) {
      throw new Error('deviceId is required');
    }

    const processed = Number.isFinite(Number(processedAt)) ? Number(processedAt) : Date.now();
    const eventTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : processed;

    this._pendingPresenceEvents = [];
    this._updatePresenceFromSensors(sensors, processed);
    const evaluation = this.evaluateStateMachine(processed);
    const presenceEvents = this._pendingPresenceEvents;
    this._pendingPresenceEvents = [];

    const payload = {
      intersectionId,
      deviceId,
      timestamp: eventTimestamp,
      processedAt: processed,
      state: this.getState(),
      evaluation,
      presenceEvents,
    };

    this.emit('state', payload.state);

    return payload;
  }

  _updatePresenceFromSensors(sensors, now) {
    Object.entries(sensors).forEach(([sensorKey, rawValue]) => {
      const laneId = this.config.sensorMap[sensorKey] || sensorKey;
      if (!this.stateByLane.has(laneId)) {
        return;
      }

      const laneState = this.stateByLane.get(laneId);
      const wasOccupied = laneState.isOccupied;
      const distance = this._parseDistance(rawValue);
      laneState.lastSampleAt = now;
      laneState.lastDistanceCm = distance;

      const hasVehicle = Number.isFinite(distance) && distance <= this.config.detectionThresholdCm;
      if (hasVehicle) {
        laneState.lastVehicleAt = now;
        if (!wasOccupied) {
          laneState.presenceStartedAt = now;
          laneState.presenceTriggeredChange = false;
        }
        laneState.isOccupied = true;
        laneState.lastClearedAt = null;
        this._enqueueLane(laneId, now);
      } else {
        laneState.isOccupied = false;
        laneState.lastClearedAt = now;

        if (wasOccupied && laneState.presenceStartedAt !== null) {
          const detectedAt = laneState.presenceStartedAt;
          const waitMs = Math.max(0, now - detectedAt);
          this._recordPresenceEvent({
            laneId,
            detectedAt,
            clearedAt: now,
            waitMs,
            triggeredChange: laneState.presenceTriggeredChange,
          });
          laneState.presenceStartedAt = null;
          laneState.presenceTriggeredChange = false;
        }

        if (laneState.waiting && laneState.state !== 'green') {
          this._removeFromQueue(laneId);
        } else if (laneState.waiting && laneState.lastVehicleAt && now - laneState.lastVehicleAt > this.config.presenceTimeoutMs) {
          this._removeFromQueue(laneId);
        }
      }
    });
  }

  _parseDistance(rawValue) {
    if (rawValue === null || rawValue === undefined) {
      return NaN;
    }
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : NaN;
  }

  evaluateStateMachine(now = Date.now()) {
    const laneState = this.stateByLane.get(this.currentLaneId);
    if (!laneState) {
      return null;
    }

    const transitions = [];
    switch (laneState.state) {
      case 'green': {
        const elapsed = now - laneState.lastChangeAt;
        const clearedAgo = laneState.lastClearedAt ? now - laneState.lastClearedAt : Infinity;
        const sinceLastVehicle = laneState.lastVehicleAt ? now - laneState.lastVehicleAt : Infinity;
        const holdDueToVehicle =
          laneState.isOccupied ||
          sinceLastVehicle <= this.config.vehiclePresenceGraceMs ||
          (Number.isFinite(clearedAgo) && clearedAgo <= this.config.holdAfterClearMs);
        const hadVehicleThisCycle =
          laneState.lastVehicleAt !== null && laneState.lastVehicleAt >= laneState.lastChangeAt;
        const canIgnoreMinGreen = hadVehicleThisCycle && !holdDueToVehicle;
        const overdueLaneId = this._findOverdueLane(now, laneState.id);
        const enforceMaxGreen = elapsed >= this.config.maxGreenMs;
        const enforceMaxRed = Boolean(overdueLaneId) && elapsed >= this.config.minGreenMs;

        if (enforceMaxGreen || enforceMaxRed) {
          const next = this._chooseNextLane(laneState.id, now);
          this.nextLaneId = next.laneId;
          const changeReason = enforceMaxGreen ? 'max-green-elapsed' : 'max-red-overdue';
          transitions.push(this._changeState(laneState.id, 'yellow', now, changeReason));
          transitions.push(this._changeState(this.nextLaneId, 'red_yellow', now, 'preparing-for-green'));
          break;
        }

        if (elapsed < this.config.minGreenMs && !canIgnoreMinGreen) {
          break;
        }

        if (holdDueToVehicle && !overdueLaneId) {
          break;
        }

        const next = this._chooseNextLane(laneState.id, now);
        this.nextLaneId = next.laneId;
        transitions.push(this._changeState(laneState.id, 'yellow', now, 'min-green-elapsed'));
        transitions.push(this._changeState(this.nextLaneId, 'red_yellow', now, 'preparing-for-green'));
        break;
      }
      case 'yellow': {
        const elapsed = now - laneState.lastChangeAt;
        if (elapsed >= this.config.yellowMs) {
          transitions.push(this._changeState(laneState.id, 'red', now, 'yellow-elapsed'));
          transitions.push(this._changeState(this.nextLaneId, 'green', now, 'yellow-elapsed'));
          this.nextLaneId = null;
        }
        break;
      }
      case 'red':
      default:
        break;
    }

    const filtered = transitions.filter(Boolean);

    if (filtered.length) {
      this.emit('state', this.getState());
    }

    return filtered;
  }

  tick(now = Date.now()) {
    return this.evaluateStateMachine(now);
  }

  _changeState(laneId, nextState, now, reason = null) {
    const laneState = this.stateByLane.get(laneId);
    if (!laneState || laneState.state === nextState) {
      return null;
    }

    const previousState = laneState.state;
    const startedAt = laneState.lastChangeAt;
    const durationMs = Math.max(0, now - startedAt);

    laneState.state = nextState;
    laneState.lastChangeAt = now;

    if (nextState === 'green') {
      this.currentLaneId = laneId;
      laneState.cyclesCompleted += 1;
      laneState.waiting = false;
      this._removeFromQueue(laneId);
      laneState.redSince = null;
      if (laneState.presenceStartedAt !== null) {
        laneState.presenceTriggeredChange = true;
      }
    }

    if (nextState === 'red') {
      laneState.redSince = now;
    }

    if (nextState === 'yellow') {
      laneState.waiting = false;
    }

    return {
      type: 'phase-change',
      laneId,
      previousState,
      nextState,
      startedAt,
      endedAt: now,
      durationMs,
      reason,
    };
  }

  _chooseNextLane(currentLaneId, now) {
    const overdueLaneId = this._findOverdueLane(now, currentLaneId);
    if (overdueLaneId) {
      this._removeFromQueue(overdueLaneId);
      return { laneId: overdueLaneId, reason: 'max-red' };
    }

    while (this.eventQueue.length > 0) {
      const candidate = this.eventQueue.shift();
      if (candidate !== currentLaneId && this.stateByLane.has(candidate)) {
        return { laneId: candidate, reason: 'queue' };
      }
    }

    const currentIndex = this.config.lanes.indexOf(currentLaneId);
    const nextIndex = (currentIndex + 1) % this.config.lanes.length;
    return { laneId: this.config.lanes[nextIndex], reason: 'round-robin' };
  }

  _findOverdueLane(now, currentLaneId) {
    const overdue = this.config.lanes
      .map((laneId) => this.stateByLane.get(laneId))
      .filter((laneState) => (
        laneState &&
        laneState.id !== currentLaneId &&
        laneState.waiting &&
        laneState.state !== 'green' &&
        laneState.redSince &&
        now - laneState.redSince >= this.config.maxRedMs
      ));

    if (overdue.length === 0) {
      return null;
    }

    overdue.sort((a, b) => a.redSince - b.redSince);
    return overdue[0].id;
  }

  _enqueueLane(laneId, now) {
    const laneState = this.stateByLane.get(laneId);
    if (!laneState || laneState.state === 'green') {
      return;
    }

    if (!laneState.waiting) {
      laneState.waiting = true;
      this.eventQueue.push(laneId);
    }
  }

  _removeFromQueue(laneId) {
    const laneState = this.stateByLane.get(laneId);
    if (laneState) {
      laneState.waiting = false;
    }
    this.eventQueue = this.eventQueue.filter((queuedLaneId) => queuedLaneId !== laneId);
  }

  _recordPresenceEvent(event) {
    if (!Array.isArray(this._pendingPresenceEvents)) {
      this._pendingPresenceEvents = [];
    }
    this._pendingPresenceEvents.push({ ...event });
  }

  getState(options = {}) {
    const now = Date.now();

    return {
      timestamp: now,
      lanes: this.config.lanes.map((laneId) => {
        const laneState = this.stateByLane.get(laneId);
        return {
          id: laneId,
          state: laneState.state,
          lastChangeAt: laneState.lastChangeAt,
          lastVehicleAt: laneState.lastVehicleAt,
          lastSampleAt: laneState.lastSampleAt,
          lastDistanceCm: laneState.lastDistanceCm,
          isOccupied: laneState.isOccupied,
          lastClearedAt: laneState.lastClearedAt,
          waiting: laneState.waiting,
          cyclesCompleted: laneState.cyclesCompleted,
          redSince: laneState.redSince,
        };
      }),
      queue: [...this.eventQueue],
      config: this.config,
      databaseConnected: options.databaseConnected ?? false,
      esp32Connected: options.esp32Connected ?? false,
    };
  }

  getLaneState(laneId) {
    const laneState = this.stateByLane.get(laneId);
    if (!laneState) {
      return null;
    }

    const now = Date.now();
    return {
      id: laneId,
      state: laneState.state,
      lastChangeAt: laneState.lastChangeAt,
      lastVehicleAt: laneState.lastVehicleAt,
      lastSampleAt: laneState.lastSampleAt,
      lastDistanceCm: laneState.lastDistanceCm,
      isOccupied: laneState.isOccupied,
      lastClearedAt: laneState.lastClearedAt,
      waiting: laneState.waiting,
      cyclesCompleted: laneState.cyclesCompleted,
      redSince: laneState.redSince,
      timestamp: now,
    };
  }

  reset(now = Date.now()) {
    this.stateByLane.clear();
    this.eventQueue = [];

    this.config.lanes.forEach((laneId, index) => {
      this.stateByLane.set(laneId, this._createInitialLaneState(laneId, index === 0, now));
    });

    this.currentLaneId = this.config.lanes[0];
    this.nextLaneId = null;
    this._pendingPresenceEvents = [];

    this.emit('state', this.getState());
  }
}

module.exports = TrafficController;
