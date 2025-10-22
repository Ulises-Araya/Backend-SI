require('dotenv').config();

const { app, server } = require('./app');

const PORT = Number(process.env.PORT || 3000);

server.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});
