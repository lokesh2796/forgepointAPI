    const { MongoClient } = require('mongodb');
    require('dotenv').config(); // Loads the .env file

    const uri = process.env.MONGO_URI;
    const DB_Name = process.env.DB_NAME
    if (!uri) {
      throw new Error('MONGO_URI not found in .env file');
    }

    const client = new MongoClient(uri);
    let db;

    async function connectDB() {
      if (db) return db;
      try {
        await client.connect();
        db = client.db(DB_Name); // You can name your database anything
        console.log('Successfully connected to MongoDB.');
        return db;
      } catch (error) {
        console.error('Could not connect to MongoDB.', error);
        process.exit(1);
      }
    }

    module.exports = { connectDB };
    
