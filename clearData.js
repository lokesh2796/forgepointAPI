const { connectDB } = require('./db');
const logger = require('./logger');

const collectionsToClear = [
    'products', 'customers', 'suppliers', 'transporters', 'categories',
    'employees', 'invoices', 'purchases', 'payments', 'advances',
    'attendance', 'payrolls', 'cashbook-entries', 'cashbook-categories'
];

async function clearData() {
    console.log('Starting to clear all data collections...');
    try {
        const db = await connectDB();

        for (const collectionName of collectionsToClear) {
            console.log(`Clearing collection: ${collectionName}...`);
            const result = await db.collection(collectionName).deleteMany({});
            console.log(`Successfully cleared ${result.deletedCount} documents from ${collectionName}.`);
        }

        console.log('Data clearing complete!');
        process.exit(0);
    } catch (error) {
        console.error('Error clearing data:', error);
        process.exit(1);
    }
}

clearData();
