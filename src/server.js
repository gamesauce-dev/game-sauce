import { prepareApp } from './app.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

const { app } = await prepareApp();

app.listen(PORT, HOST, () => {
  console.log(`game-sauce listening on http://${HOST}:${PORT}`);
});
