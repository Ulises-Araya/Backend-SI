# ESP32 Backend

Servidor HTTP para prototipos IoT con ESP32. Recibe mediciones de sensores ultrasónicos, calcula la fase de un semáforo inteligente virtual y expone la información mediante una API REST y un tablero web ligero. Puede persistir los eventos de tráfico procesados en [Supabase](https://supabase.com/) (PostgreSQL administrado) y, en ausencia de credenciales, mantiene todo el registro únicamente en memoria mientras el proceso esté activo.

## Características principales

- **POST `/api/messages`**: recibe datos en JSON desde el ESP32 (o cualquier cliente HTTP).
- **POST `/api/traffic/events`**: ingiere distancias medidas por los sensores ultrasónicos y actualiza la lógica del semáforo inteligente.
- **GET `/api/traffic/lights`**: devuelve el estado completo de los cuatro semáforos, la cola de prioridad y los parámetros configurados.
- **GET `/api/traffic/lights/:laneId`**: responde sólo con la información del semáforo indicado (ej. `north`, `west`, `south`, `east`).
- **GET `/api/messages`** / **`/api/messages/latest`**: historial de eventos crudo.
- **GET `/`**: tablero HTML que muestra el estado actual del cruce y el log de mensajes, actualizado automáticamente cada ~2 s.
- Logs de cada petición y soporte CORS habilitado por defecto para permitir pruebas desde navegadores en otras máquinas de la red local.

Cuando se definen las variables `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`, el backend almacena los eventos de tráfico procesados en una tabla Postgres gestionada por Supabase. El log de mensajes crudo permanece en memoria y se reinicia al volver a iniciar el servidor.

## Requisitos previos

- [Node.js](https://nodejs.org/) v18 o superior
- npm (incluido con Node.js)

## Instalación

Instala las dependencias del proyecto:

```powershell
npm install
```

### Configuración de Supabase (opcional pero recomendado)

1. En tu proyecto de Supabase crea la tabla de eventos con el siguiente esquema base:

   ```sql
   create table if not exists public.traffic_events (
     id uuid primary key,
     device_id text not null,
     intersection_id text,
     sensors jsonb,
     state_snapshot jsonb,
     evaluation jsonb,
     ip text,
     received_at timestamptz default timezone('utc', now())
   );

   create index if not exists idx_traffic_events_received_at on public.traffic_events (received_at desc);
   ```

2. Desde la consola de Supabase, genera un **Service Role Key** y guárdalo (no lo compartas en el frontend).
3. Copia `.env.example` a `.env` y completa:

   ```bash
   SUPABASE_URL="https://<tu-proyecto>.supabase.co"
   SUPABASE_SERVICE_KEY="<service-role-key>"
   SUPABASE_TRAFFIC_EVENTS_TABLE=traffic_events
   ```

4. Reinicia el servidor para que cargue las variables.

## Ejecución en modo desarrollo

Lanza el servidor con recarga automática:

```powershell
npm run dev
```

Luego abre <http://localhost:3000> en tu navegador o apunta el ESP32 a `http://<IP_DEL_PC>:3000`.

## Ejecución en modo producción

```powershell
npm start
```

## Pruebas automatizadas

```powershell
npm test
```

## Ejemplos de uso

### Envío de datos desde ESP32 (Arduino)

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* ssid = "TU_SSID";
const char* password = "TU_PASSWORD";
const char* serverUrl = "http://192.168.0.100:3000/api/traffic/events"; // Ajusta la IP del backend

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nConectado al WiFi");
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverUrl);
    http.addHeader("Content-Type", "application/json");

  String payload = "{\"deviceId\":\"esp32-semaforo\","
            "\"sensors\":{\"sensor1\":25.3,\"sensor2\":18.9,\"sensor3\":999,\"sensor4\":999}}";

    int httpResponseCode = http.POST(payload);
    Serial.printf("Respuesta del servidor: %d\n", httpResponseCode);
    http.end();
  }

  delay(5000); // Envía cada 5 segundos
}
```

### Prueba rápida con `curl`

```powershell
curl -X POST http://localhost:3000/api/traffic/events `
  -H "Content-Type: application/json" `
  -d '{"deviceId":"esp32-lab","sensors":{"sensor1":12.5,"sensor2":70,"sensor3":999,"sensor4":999}}'
```

### Respuesta esperada (JSON)

```json
{
  "message": "Evento procesado",
  "state": {
    "timestamp": 1732992000000,
    "lanes": [
      {
        "id": "north",
        "state": "green",
        "waiting": false,
        "lastDistanceCm": 12.5
      },
      { "id": "west", "state": "red", "waiting": true, "lastDistanceCm": 70 },
      {
        "id": "south",
        "state": "red",
        "waiting": false,
        "lastDistanceCm": 999
      },
      { "id": "east", "state": "red", "waiting": false, "lastDistanceCm": 999 }
    ],
    "queue": ["west"],
    "config": {
      "detectionThresholdCm": 30,
      "minGreenMs": 8000,
      "yellowMs": 3000,
      "maxRedMs": 60000
    }
  }
}
```

### Cómo funciona la lógica del semáforo inteligente

- El ciclo base sigue un recorrido anti-horario (`north → west → south → east`).
- Cada vez que un sensor mide una distancia menor o igual al umbral (`DETECTION_THRESHOLD_CM`, por defecto 30 cm), el carril se marca como "en espera" y se agrega a una cola de prioridad.
- El semáforo en verde actual debe permanecer al menos `MIN_GREEN_MS` (8 s por defecto). Si no hay más autos en su carril o la cola tiene pendientes, cambia a amarillo (`YELLOW_MS`, 3 s) y luego a rojo.
- Mientras el sensor siga detectando un vehículo (distancia ≤ `DETECTION_THRESHOLD_CM`) el semáforo se mantiene en verde. Cuando la distancia aumenta, se espera un pequeño margen (`HOLD_AFTER_CLEAR_MS`, 2 s por defecto) para permitir que otro vehículo cercano pueda cruzar sin cortar el paso justo encima.
- Al finalizar el amarillo, se asigna verde al primer carril de la cola. Si la cola está vacía, continúa el ciclo anti-horario habitual.
- Si un carril permanece en rojo durante más de `MAX_RED_MS` (60 s) y todavía tiene autos esperando, se adelanta en la prioridad para evitar inanición.
- El estado y la cola se sirven en la API y en la página HTML para que puedas simular las luces en el frontend.

## Configuración

- `PORT`: Puerto TCP donde escucha el servidor (por defecto `3000`). Puedes definirlo en un archivo `.env` basado en el archivo `.env.example`.
- `MAX_MESSAGES`: Número máximo de mensajes que se mantienen en memoria (por defecto `500`). Cuando se supera, se eliminan los más antiguos.
- `DETECTION_THRESHOLD_CM`: Distancia máxima (en centímetros) para considerar que hay un vehículo delante del sensor (por defecto `30`).
- `MIN_GREEN_MS`: Tiempo mínimo (en milisegundos) que un carril debe permanecer en verde antes de liberar el paso (por defecto `8000`).
- `MAX_GREEN_MS`: (obsoleto) se mantiene por compatibilidad, pero el controlador actual cambia de fase apenas se cumple el tiempo mínimo y no existe presencia en el carril.
- `YELLOW_MS`: Duración del amarillo antes de cambiar a rojo (por defecto `3000`).
- `MAX_RED_MS`: Tiempo máximo en rojo para otorgar prioridad a un carril que lleva mucho esperando (por defecto `60000`).
- `PRESENCE_TIMEOUT_MS`: Tiempo tras el cual una detección expira si el ESP32 deja de informar presencia (por defecto `10000`).
- `HOLD_AFTER_CLEAR_MS`: Tiempo de gracia, después de que el sensor detecta que el carril quedó libre, para mantener el verde si aparece otro vehículo inmediatamente detrás (por defecto `2000`).
- `TICK_INTERVAL_MS`: Cada cuánto (en milisegundos) se evalúa automáticamente la máquina de estados del semáforo (por defecto `1000`).
- `SUPABASE_URL`: URL base de tu instancia Supabase. Si no se define, la persistencia remota se omite.
- `SUPABASE_SERVICE_KEY`: clave de servicio (role key) utilizada sólo por el backend. No exponer en clientes.
- `SUPABASE_TRAFFIC_EVENTS_TABLE`: tabla específica para eventos de tráfico procesados.

## Próximos pasos sugeridos

- Ampliar la consola web con filtros, gráficos y estadísticas históricas consumiendo directamente desde Supabase.
- Añadir autenticación por token para filtrar quién puede enviar datos al backend.
- Notificar cambios de fase mediante MQTT u otro canal push a un frontend en tiempo real.
- Incorporar lógica adicional (peatones, horarios pico, prioridad a transporte público, etc.).
