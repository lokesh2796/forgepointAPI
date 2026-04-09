    const { connectDB } = require('./db');
    const fs = require('fs');

    const collectionsToMigrate = [
      'products', 'customers', 'suppliers', 'transporters', 'categories',
      'employees', 'invoices', 'purchases', 'payments', 'advances','attendances','payrolls'
    ];

    async function migrate() {
      console.log('Starting migration...');
      const db = await connectDB();

      for (const collectionName of collectionsToMigrate) {
        try {
          console.log(`Migrating ${collectionName}...`);
          const filePath = `./assets/data/${collectionName}.json`;
          
          if (!fs.existsSync(filePath)) {
            console.warn(`File not found for ${collectionName}, skipping.`);
            continue;
          }

          const rawData = fs.readFileSync(filePath);
          const data = JSON.parse(rawData);

          if (data && data.length > 0) {
            const collection = db.collection(collectionName);
            await collection.deleteMany({}); // Clear existing data
            await collection.insertMany(data); // Insert new data
            console.log(`Successfully migrated ${data.length} documents to ${collectionName}.`);
          } else {
            console.log(`No data to migrate for ${collectionName}.`);
          }
        } catch (error) {
          console.error(`Failed to migrate ${collectionName}:`, error);
        }
      }

      console.log('Migration complete!');
      process.exit();
    }

    migrate();
    
