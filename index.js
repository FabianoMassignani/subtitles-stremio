import { connectDB } from "./src/services/database.js";
import { createServer, CONFIG } from "./src/services/stremio.js";
import "dotenv/config";

const server = createServer();

async function start() {
  await connectDB();

  server.listen(CONFIG.PORT, () => {
    console.log("Servidor rodando na porta", CONFIG.PORT);
  });
}

start();
