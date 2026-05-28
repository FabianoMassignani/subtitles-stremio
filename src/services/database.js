import { MongoClient } from "mongodb";

let client;

export const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    console.log("MONGO_URI não definida, pulando conexão com banco.");
    return;
  }
  client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  console.log("Mongo conectado");
};

export const getDB = () => {
  if (!client) throw new Error("Banco não conectado");
  return client.db("mercadopago");
};
