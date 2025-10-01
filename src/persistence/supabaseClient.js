const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

let client = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        'x-application-name': 'esp32-backend',
      },
    },
  });
} else {
  if (process.env.NODE_ENV !== 'test') {
    console.warn('[supabase] Variables SUPABASE_URL y/o SUPABASE_SERVICE_KEY no definidas. La persistencia remota se omitirá.');
  }
}

function getClient() {
  return client;
}

module.exports = {
  getClient,
};
