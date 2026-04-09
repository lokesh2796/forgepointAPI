const { connectDB } = require('./db');

async function seedSampleData() {
    try {
        const db = await connectDB();

        // 1. Categories
        const categories = [
            { id: 1, name: 'Finished Goods', unit: 'PCS' },
            { id: 2, name: 'Raw Materials', unit: 'KG' },
            { id: 3, name: 'Supplies', unit: 'BOX' }
        ];
        await db.collection('categories').insertMany(categories);

        // 2. Products
        const products = [
            { id: 1, name: 'Industrial Valve A1', category: 'Finished Goods', hsn: '8481', stock: 120, priceGst: 4500, priceNonGst: 3813, categoryId: 1 },
            { id: 2, name: 'Steel Pipe 2 Inch', category: 'Raw Materials', hsn: '7304', stock: 500, priceGst: 850, priceNonGst: 720, categoryId: 2 },
            { id: 3, name: 'Hydraulic Seal Kit', category: 'Supplies', hsn: '4016', stock: 45, priceGst: 1200, priceNonGst: 1017, categoryId: 3 }
        ];
        await db.collection('products').insertMany(products);

        // 3. Customers
        const customers = [
            { id: 1, name: 'Global Tech Industries', phone: '9123456780', address: 'Bandra-Kurla Complex, Mumbai', outstandingBalance: 25000, oldBalance: 15000 },
            { id: 2, name: 'South Construction Group', phone: '9876543211', address: 'Whitefield, Bangalore', outstandingBalance: 8500, oldBalance: 0 }
        ];
        await db.collection('customers').insertMany(customers);

        // 4. Suppliers
        const suppliers = [
            { id: 1, name: 'Standard Steel Ltd', phone: '8005550199', address: 'Jamshedpur, Jharkhand' },
            { id: 2, name: 'Universal Components', phone: '2227771111', address: 'Chennai, Tamil Nadu' }
        ];
        await db.collection('suppliers').insertMany(suppliers);

        // 5. Cashbook Categories
        const cashbookCategories = [
            { id: 1, name: 'Sales', type: 'in' },
            { id: 2, name: 'Purchase', type: 'out' },
            { id: 3, name: 'Salary', type: 'out' },
            { id: 4, name: 'Rent', type: 'out' },
            { id: 5, name: 'Customer Payment', type: 'in' }
        ];
        await db.collection('cashbook-categories').insertMany(cashbookCategories);

        console.log('Sample data seeding complete!');
        process.exit(0);
    } catch (error) {
        console.error('Error seeding data:', error);
        process.exit(1);
    }
}

seedSampleData();
