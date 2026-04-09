const { connectDB } = require('./db');

async function updateProfile() {
    try {
        const db = await connectDB();
        const newProfile = {
            companyName: 'Apex Industrial Solutions',
            gstin: '27AADCA1234F1Z5',
            address: 'Plot No. 42, Innovation Hub, Phase III, HITEC City, Hyderabad, Telangana - 500081',
            phone: '+91 98765 43210 | 040 2345 6789',
            email: 'contact@apex-industrial.com',
            cgstRate: 9,
            sgstRate: 9,
            currencySymbol: '₹',
            lowStockThreshold: 50
        };

        const result = await db.collection('users').updateOne(
            { username: 'admin' },
            { $set: { profile: newProfile } }
        );

        if (result.matchedCount > 0) {
            console.log('Successfully updated company profile for admin.');
        } else {
            console.log('Admin user not found.');
        }
        process.exit(0);
    } catch (error) {
        console.error('Error updating profile:', error);
        process.exit(1);
    }
}

updateProfile();
