const express = require('express');
const cors = require('cors');
const { connectDB } = require('./db'); // Import our DB connection
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const logger = require('./logger');
const { error } = require('winston');

const app = express();
const port = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-default-secret-key'; // Add a JWT_SECRET to your .env file!
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'your-refresh-secret-key';
const round = (val) => Math.round((val + Number.EPSILON) * 100) / 100;

function getFinancialYearRange(date) {
  const d = new Date(date);
  const month = d.getMonth(); // 0-indexed, 3 is April
  const year = d.getFullYear();
  let start;
  if (month < 3) {
    start = new Date(year - 1, 3, 1, 0, 0, 0, 0); // April 1st of previous year
  } else {
    start = new Date(year, 3, 1, 0, 0, 0, 0); // April 1st of current year
  }
  const end = new Date(start);
  end.setFullYear(start.getFullYear() + 1); // April 1st of next year
  return { start, end };
}

app.use(cors());
app.use(express.json());

let db;

// --- FUNCTION TO ENSURE DEFAULT CATEGORIES EXIST ---
async function ensureDefaultCategories(database) {
  const categoriesCollection = database.collection('cashbook-categories');
  const defaults = [];

  for (const cat of defaults) {
    const existing = await categoriesCollection.findOne({ name: cat.name });
    if (!existing) {
      const lastDoc = await categoriesCollection.findOne({}, { sort: { id: -1 } });
      const nextId = lastDoc ? lastDoc.id + 1 : 1;
      await categoriesCollection.insertOne({ id: nextId, ...cat });
      logger.info(`Created default cashbook category: "${cat.name}"`);
    }
  }
}


connectDB().then(async database => {
  db = database;
  // --- Ensure default categories exist on startup ---
  await ensureDefaultCategories(db);
  app.listen(port, () => {
    logger.info(`Backend server listening at http://localhost:${port} and connected to MongoDB.`);
  });
}).catch(error => {
  logger.error('Failed to connect to MongoDB on startup.', { stack: error.stack });
  process.exit(1);
});

async function updateHelperFunctions(newData, collectionName) {
  let customer_id = parseInt(newData.customerId);
  const collection1 = db.collection(collectionName);
  const originalCustomer = await collection1.findOne({ id: customer_id });
  const duplicateValue = await collection1.findOne({ id: customer_id });
  if (originalCustomer) {
    if (newData.amount > originalCustomer.oldBalance) {
      return "check the Opening Balance and update";
    }
    else {
      originalCustomer.oldBalance = originalCustomer.oldBalance - newData.amount
    }
    const result1 = await collection1.updateOne({ id: customer_id }, { $set: originalCustomer });
    if (result1.matchedCount === 0) {
      logger.warn(`PUT /api/customers/${id} - Document not found.`);
      return res.status(404).send('Document not found');
    }
    return duplicateValue
  }
}

async function createHelperFunctions(newData, collectionName) {
  const collection = db.collection(collectionName);
  const lastDoc = await collection.findOne({}, { sort: { id: -1 } });
  newData.id = lastDoc ? lastDoc.id + 1 : 1;
  await collection.insertOne(newData);
  return 'created record'
}
// --- NEW: LOGIN ENDPOINT ---
app.post('/api/users/login', async (req, res) => {
  const { username, password } = req.body;
  logger.info(`POST /api/users/login - Attempting login for user: ${username}`);
  if (!username || !password) {
    logger.warn(`Login attempt failed for ${username}: Missing credentials.`);
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const user = await db.collection('users').findOne({ username });
  if (!user) {
    logger.warn(`Login attempt failed for ${username}: User not found.`);
    return res.status(401).json({ message: 'Invalid credentials.' });
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    logger.warn(`Login attempt failed for ${username}: Invalid password.`);
    return res.status(401).json({ message: 'Invalid credentials.' });
  }

  const accessToken = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '8h' }); // Short-lived
  const refreshToken = jwt.sign({ userId: user.id, username: user.username }, REFRESH_TOKEN_SECRET, { expiresIn: '14d' }); // Long-lived

  logger.info(`Login successful for user: ${username}. Token generated.`);
  res.json({ success: true, accessToken, refreshToken });
});


// --- NEW: REFRESH TOKEN ENDPOINT ---
app.post('/api/users/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken == null) return res.sendStatus(401);

  jwt.verify(refreshToken, REFRESH_TOKEN_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);

    // If refresh token is valid, create a new access token
    const accessToken = jwt.sign({ userId: user.userId, username: user.username }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ accessToken });
  });
});

// --- AUTHENTICATION MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) {
    logger.warn(`Unauthorized request to ${req.path}: No token provided.`);
    return res.sendStatus(401);
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      logger.warn(`Forbidden request to ${req.path}: Token is invalid or expired.`);
      return res.sendStatus(403);
    }
    req.user = user;
    next();
  });
};


// --- Generic CRUD Endpoints for Simple Models ---
const createCrudEndpoints = (collectionName) => {
  try {
    // GET all documents
    app.get(`/api/${collectionName}`, authenticateToken, async (req, res) => {
      logger.info(`GET /api/${collectionName} - Fetching all documents.`);
      const collection = db.collection(collectionName);
      const data = await collection.find({}).sort({ id: 1 }).toArray();
      res.json(data);
    });

    // POST a new document
    app.post(`/api/${collectionName}`, authenticateToken, async (req, res) => {
      logger.info(`POST /api/${collectionName} - Creating new document.`);
      const collection = db.collection(collectionName);
      const newData = req.body;
      const lastDoc = await collection.findOne({}, { sort: { id: -1 } });
      newData.id = lastDoc ? lastDoc.id + 1 : 1;
      if (newData.date) {
        const clientDate = new Date(newData.date); // The date selected by the user
        const now = new Date(); // The current server time
        // Combine the user's date with the server's time
        const finalDateTime = new Date(
          clientDate.getFullYear(),
          clientDate.getMonth(),
          clientDate.getDate(),
          now.getHours(),
          now.getMinutes(),
          now.getSeconds()
        );
        newData.date = new Date(finalDateTime).toISOString();
      }
      if (collectionName === 'customers') {
        newData.oldBalance = newData.oldBalance || 0;
        newData.outstandingBalance = newData.outstandingBalance || 0;
      }
      else if (collectionName === 'cashbook-entries' && newData.customerId && parseInt(newData.customerId) > 0) {
        newData.customerId = parseInt(newData.customerId)
        let dataupdated1 = await updateHelperFunctions(newData, 'customers');
        if (!dataupdated1.oldBalance && dataupdated1.includes('check')) {
          throw new Error('Check the opening balance');
        }
        else {
          if (parseInt(newData.categoryId) == 1) {
            newData.categoryId = parseInt(newData.categoryId)
            newData.description = `Settlement Amount from ${dataupdated1.name}, Previous balance is ₹${dataupdated1.oldBalance} and Amount recieved is ₹${newData.amount}, Balance to be paid in Opening Balance Amount is ₹${parseInt(dataupdated1.oldBalance) - parseInt(newData.amount)} ${newData.description}`

          }
          let payment_payload = {
            invoiceId: 'TRN-' + Math.floor(Math.random() * 99999999),
            customerId: parseInt(newData.customerId),
            date: new Date().toISOString(),
            amount: newData.amount,
            mode: 'cash'
          }
          let dataupdated = await createHelperFunctions(payment_payload, 'payments');
          console.log(dataupdated, dataupdated1);
        }
      }
      await collection.insertOne(newData);
      res.status(201).json(newData);
    });


    // PUT (update) an existing document
    app.put(`/api/${collectionName}/:id`, authenticateToken, async (req, res) => {
      const collection = db.collection(collectionName);
      const id = parseInt(req.params.id);
      logger.info(`PUT /api/${collectionName}/${id} - Updating document.`);
      const { _id, ...updateData } = req.body;
      const result = await collection.updateOne({ id: id }, { $set: updateData });
      if (result.matchedCount === 0) {
        logger.warn(`PUT /api/${collectionName}/${id} - Document not found.`);
        return res.status(404).send('Document not found');
      }
      res.json(updateData);
    });

    // DELETE a document
    app.delete(`/api/${collectionName}/:id`, authenticateToken, async (req, res) => {
      const collection = db.collection(collectionName);
      const id = parseInt(req.params.id);
      const result = await collection.deleteOne({ id: id });
      if (result.deletedCount === 0) return res.status(404).send('Document not found');
      res.status(204).send();
    });
  } catch (err) { // <-- Add catch here
    logger.error(`Error in POST /api/${collectionName}: ${err.message}`);

    // Send a specific error response for your thrown error
    if (err.message === 'Check the opening balance') {
      // 400 Bad Request is appropriate for this kind of validation error
      res.status(400).json({ error: err.message });
    } else {
      // For all other unexpected errors (DB down, etc.)
      res.status(500).json({ error: 'An internal server error occurred' });
    }
  }
};

// Create CRUD endpoints for all the simple models
['products', 'customers', 'suppliers', 'transporters', 'employees', 'payments', 'cashbook-categories', 'cashbook-entries'].forEach(createCrudEndpoints);


// --- SPECIALIZED API ENDPOINTS WITH CUSTOM LOGIC ---

// --- Category API Endpoints ---
const categoriesCollection = 'categories';
const categoriesApiPath = `/api/${categoriesCollection}`;

app.get(categoriesApiPath, authenticateToken, async (req, res) => {
  logger.info(`GET ${categoriesApiPath} - Fetching all documents.`);
  const data = await db.collection(categoriesCollection).find({}).sort({ id: 1 }).toArray();
  res.json(data);
});
app.post(categoriesApiPath, authenticateToken, async (req, res) => {
  logger.info(`POST ${categoriesApiPath} - Creating new document.`);
  const collection = db.collection(categoriesCollection);
  const newData = req.body;
  const lastDoc = await collection.findOne({}, { sort: { id: -1 } });
  newData.id = lastDoc ? lastDoc.id + 1 : 1;
  const result = await collection.insertOne(newData);
  res.status(201).json(result);
});
app.put(`${categoriesApiPath}/:id`, authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id);
  logger.info(`PUT ${categoriesApiPath}/${id} - Updating document.`);
  const { _id, ...updateData } = req.body;
  const result = await db.collection(categoriesCollection).updateOne({ id: id }, { $set: updateData });
  if (result.matchedCount === 0) return res.status(404).send('Document not found');
  res.json(updateData);
});
app.delete(`${categoriesApiPath}/:id`, authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id);
  logger.info(`DELETE ${categoriesApiPath}/${id} - Deleting document.`);
  const result = await db.collection(categoriesCollection).deleteOne({ id: id });
  if (result.deletedCount === 0) return res.status(404).send('Document not found');
  res.status(204).send();
});

// --- NEW: BULK CATEGORY IMPORT ENDPOINT ---
app.post('/api/categories/bulk', authenticateToken, async (req, res) => {
  const categoriesToImport = req.body;
  if (!Array.isArray(categoriesToImport) || categoriesToImport.length === 0) {
    logger.warn('POST /api/categories/bulk - Received invalid or empty array.');
    return res.status(400).send('Category data must be a non-empty array.');
  }
  logger.info(`POST /api/categories/bulk - Received ${categoriesToImport.length} categories to import.`);

  try {
    const categoriesCollection = db.collection('categories');
    const existingNames = (await categoriesCollection.find({}, { projection: { name: 1 } }).toArray())
      .map(c => c.name.toLowerCase());
    const lastDoc = await categoriesCollection.findOne({}, { sort: { id: -1 } });
    let nextId = lastDoc ? lastDoc.id + 1 : 1;
    const categoriesToInsert = [];
    const skippedCategories = [];

    for (const category of categoriesToImport) {
      if (!category.name || !category.unit) {
        skippedCategories.push({ category, reason: 'Missing name or unit' });
        continue;
      }
      if (existingNames.includes(category.name.toLowerCase())) {
        skippedCategories.push({ category, reason: 'Name already exists' });
      } else {
        categoriesToInsert.push({ id: nextId++, ...category });
        existingNames.push(category.name.toLowerCase());
      }
    }

    if (categoriesToInsert.length > 0) {
      await categoriesCollection.insertMany(categoriesToInsert);
      logger.info(`Successfully bulk-inserted ${categoriesToInsert.length} categories.`);
    }

    res.status(201).json({
      message: 'Import complete.',
      created: categoriesToInsert.length,
      skipped: skippedCategories.length,
      skippedDetails: skippedCategories
    });
  } catch (error) {
    logger.error('Failed during bulk category import:', { stack: error.stack });
    res.status(500).json({ message: 'An error occurred during the import process.' });
  }
});

// --- Invoices & Estimates ---
app.get('/api/invoices', authenticateToken, async (req, res) => {
  logger.info('GET /api/invoices - Fetching all invoices/estimates.');
  const data = await db.collection('invoices').find({}).sort({ date: 1, id: 1 }).toArray();
  res.json(data);
});

// UPDATED POST endpoint to handle both Estimates and Invoices
app.post('/api/invoices', authenticateToken, async (req, res) => {
  try {
    const newData = req.body;
    logger.info(`POST /api/invoices - Creating new ${newData.type || 'document'}.`);

    let prefix = '';
    let lastDoc;
    let newId;

    // Use invoice date to determine financial year
    const clientDate = new Date(newData.date);
    const fy = getFinancialYearRange(clientDate);

    // 1. Determine ID prefix based on type
    if (newData.type === 'Estimate') {
      prefix = 'EST-';
    } else if (newData.type === 'Invoice') {
      prefix = newData.gstAvailable ? 'GST-' : 'INV-';
    } else {
      logger.error(`Invalid type received in POST /api/invoices: ${newData.type}`);
      return res.status(400).json({ message: "Invalid document type provided." });
    }

    // Find the last document with this prefix IN THE CURRENT FINANCIAL YEAR
    lastDoc = await db.collection('invoices').findOne({
      id: { $regex: `^${prefix}` },
      date: {
        $gte: fy.start.toISOString(),
        $lt: fy.end.toISOString()
      }
    }, { sort: { id: -1 } });

    const lastNum = lastDoc ? parseInt(lastDoc.id.split('-')[1]) : 0;
    newId = `${prefix}${('000' + (lastNum + 1)).slice(-3)}`;

    // Combine client date with server time
    const now = new Date();
    const finalDateTime = new Date(
      clientDate.getUTCFullYear(), clientDate.getUTCMonth(), clientDate.getUTCDate(), // Use UTC date parts
      now.getHours(), now.getMinutes(), now.getSeconds() // Use local server time parts
    );
    newData.date = finalDateTime.toISOString(); // Store as ISO string

    const finalDocument = { id: newId, ...newData };

    // 2. ONLY update customer balance if it's an Invoice
    if (finalDocument.type === 'Invoice') {
      if (!finalDocument.customer || typeof finalDocument.customer.id !== 'number') {
        logger.error(`Cannot update balance: Invalid customer data for Invoice ${newId}`);
        return res.status(400).json({ message: "Invalid customer data for invoice." });
      }
      logger.info(`Updating customer balance for Invoice ${newId}. Amount: ${finalDocument.total}`);
      await db.collection('customers').updateOne(
        { id: finalDocument.customer.id },
        { $inc: { outstandingBalance: finalDocument.total } }
      );
    }

    // 3. Insert the new document (Invoice or Estimate)
    const insertResult = await db.collection('invoices').insertOne(finalDocument);
    logger.info(`${finalDocument.type} ${newId} created successfully.`);

    // --- START OF CASHBOOK LOGIC -- 
    if (finalDocument.type === 'Invoice' && finalDocument.total > 0) {
      logger.info(`Attempting to create Sales cashbook entry for Invoice ${finalDocument.id}`);
      const salesCategory = await db.collection('cashbook-categories').findOne({ name: 'Sales' });
      if (salesCategory) {
        const lastEntry = await db.collection('cashbook-entries').findOne({}, { sort: { id: -1 } });
        const nextEntryId = lastEntry ? lastEntry.id + 1 : 1;
        const cashbookDateTime = new Date(finalDocument.date);
        const salesEntry = {
          id: nextEntryId,
          date: cashbookDateTime.toISOString(),
          categoryId: salesCategory.id,
          description: `Sales from Invoice #${finalDocument.id} to ${finalDocument.customer.name}`,
          amount: finalDocument.total,
          type: salesCategory.type // Use type from category
        };
        await db.collection('cashbook-entries').insertOne(salesEntry);
        logger.info(`Created Sales cashbook entry ID ${nextEntryId} for Invoice ${finalDocument.id}`);
      } else {
        logger.warn(`Could not create Sales cashbook entry for Invoice ${finalDocument.id}: 'Sales' category not found.`);
      }
    }
    // --- END OF CASHBOOK LOGIC ---

    res.status(201).json(insertResult);

  } catch (error) {
    logger.error(`Error in POST /api/invoices:`, { stack: error.stack });
    res.status(500).json({ message: 'Server error during invoice/estimate creation.' });
  }
});

// PUT Invoice/Estimate (Handles both types)
app.put('/api/invoices/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  logger.info(`PUT /api/invoices/${id} - Updating invoice/estimate.`);
  const updatedData = req.body;

  // Combine client date with server time for the update
  const clientDate = new Date(updatedData.date);
  const now = new Date();
  const finalDateTime = new Date(
    clientDate.getUTCFullYear(), clientDate.getUTCMonth(), clientDate.getUTCDate(),
    now.getHours(), now.getMinutes(), now.getSeconds()
  );
  updatedData.date = finalDateTime.toISOString();

  const originalDoc = await db.collection('invoices').findOne({ id: id });
  if (!originalDoc) {
    logger.warn(`PUT /api/invoices/${id} - Document not found.`);
    return res.status(404).send('Invoice or Estimate not found');
  }

  // Calculate balance difference ONLY if it's an Invoice
  let totalDifference = 0;
  if (originalDoc.type === 'Invoice' && updatedData.type === 'Invoice') {
    totalDifference = updatedData.total - originalDoc.total;
    logger.info(`Invoice ${id} total changed. Adjusting customer balance by ${totalDifference}.`);
    await db.collection('customers').updateOne(
      { id: originalDoc.customer.id },
      { $inc: { outstandingBalance: totalDifference } }
    );
  }

  // Update the document
  const { _id, ...updateFields } = updatedData;
  await db.collection('invoices').updateOne({ id: id }, { $set: updateFields });
  res.json(updateFields); // Return the updated data
});

// POST Payment (Only affects Invoices)
app.post('/api/invoices/:invoiceId/payments', authenticateToken, async (req, res) => {
  const { invoiceId } = req.params;
  logger.info(`POST /api/invoices/${invoiceId}/payments - Recording payment.`);
  const { amount, mode, date } = req.body;
  const paymentAmount = parseFloat(amount);

  const invoice = await db.collection('invoices').findOne({ id: invoiceId, type: 'Invoice' }); // Ensure it's an invoice
  if (!invoice) {
    logger.warn(`Payment recording failed: Invoice ${invoiceId} not found or is an Estimate.`);
    return res.status(404).send('Invoice not found or cannot apply payment to Estimate.');
  }

  // Combine client date with server time
  const clientDate = new Date(date);
  const now = new Date();
  const finalDateTime = new Date(
    clientDate.getUTCFullYear(), clientDate.getUTCMonth(), clientDate.getUTCDate(),
    now.getHours(), now.getMinutes(), now.getSeconds()
  );

  const lastPayment = await db.collection('payments').findOne({}, { sort: { id: -1 } });
  const newPaymentId = lastPayment ? lastPayment.id + 1 : 1;
  const newPayment = {
    id: newPaymentId,
    customerId: invoice.customer.id,
    invoiceId,
    amount: paymentAmount,
    mode,
    date: finalDateTime.toISOString()
  };
  await db.collection('payments').insertOne(newPayment);

  // Update invoice status and balances
  const newAmountPaid = round(invoice.amountPaid + paymentAmount);
  const newBalanceDue = round(invoice.balanceDue - paymentAmount);
  const newStatus = newBalanceDue <= 0 ? 'Paid' : 'Partially Paid';
  await db.collection('invoices').updateOne(
    { id: invoiceId },
    { $set: { amountPaid: newAmountPaid, balanceDue: Math.max(0, newBalanceDue), status: newStatus } } // Prevent negative balance
  );

  // Update customer's outstanding balance
  await db.collection('customers').updateOne(
    { id: invoice.customer.id },
    { $inc: { outstandingBalance: -paymentAmount } }
  );

  // --- CASHBOOK ENTRY FOR PAYMENT ---
  logger.info(`Attempting to create Customer Payment cashbook entry for Invoice ${invoiceId}`);
  const paymentCategory = await db.collection('cashbook-categories').findOne({ name: 'Customer Payment' });
  if (paymentCategory) {
    const lastEntry = await db.collection('cashbook-entries').findOne({}, { sort: { id: -1 } });
    const nextEntryId = lastEntry ? lastEntry.id + 1 : 1;
    const paymentEntry = {
      id: nextEntryId,
      date: finalDateTime.toISOString(),
      categoryId: paymentCategory.id,
      description: `Payment received for Invoice #${invoiceId} from ${invoice.customer.name}`,
      amount: paymentAmount,
      type: paymentCategory.type // Should be 'in'
    };
    await db.collection('cashbook-entries').insertOne(paymentEntry);
    logger.info(`Created Customer Payment cashbook entry ID ${nextEntryId} for Invoice ${invoiceId}`);
  } else {
    logger.warn(`Could not create Customer Payment cashbook entry: 'Customer Payment' category not found.`);
  }
  // --- END OF CASHBOOK ENTRY ---

  res.status(201).json(newPayment);
});

// --- NEW: CONVERT ESTIMATE TO INVOICE ENDPOINT ---
app.post('/api/invoices/:id/convert', authenticateToken, async (req, res) => {
  const { id } = req.params; // Estimate ID
  logger.info(`POST /api/invoices/${id}/convert - Converting Estimate to Invoice.`);
  try {
    const estimate = await db.collection('invoices').findOne({ id: id, type: 'Estimate' });
    if (!estimate) {
      logger.warn(`Conversion failed: Estimate ${id} not found.`);
      return res.status(404).send('Estimate not found.');
    }
    if (estimate.status === 'Converted') {
      logger.warn(`Conversion failed: Estimate ${id} is already converted.`);
      return res.status(400).send('Estimate has already been converted.');
    }

    // Generate a new Invoice ID (GST- or INV-) based on current FY
    const invoicePrefix = estimate.gstAvailable ? 'GST-' : 'INV-';
    const conversionDate = new Date(); // Use today's date for conversion
    const fy = getFinancialYearRange(conversionDate);

    const lastInvoiceDoc = await db.collection('invoices').findOne({
      id: { $regex: `^${invoicePrefix}` },
      date: {
        $gte: fy.start.toISOString(),
        $lt: fy.end.toISOString()
      }
    }, { sort: { id: -1 } });
    const lastInvoiceNum = lastInvoiceDoc ? parseInt(lastInvoiceDoc.id.split('-')[1]) : 0;
    const newInvoiceId = `${invoicePrefix}${('000' + (lastInvoiceNum + 1)).slice(-3)}`;

    // Combine estimate date with current time for the new invoice
    const estimateDate = new Date(estimate.date);
    const now = new Date();
    const finalDateTime = new Date(
      estimateDate.getUTCFullYear(), estimateDate.getUTCMonth(), estimateDate.getUTCDate(),
      now.getHours(), now.getMinutes(), now.getSeconds()
    );

    const newInvoice = {
      ...estimate,
      _id: new ObjectId(), // Generate new internal MongoDB ID
      id: newInvoiceId,
      type: 'Invoice',
      date: finalDateTime.toISOString(), // Use combined date/time
      status: 'Due',
      amountPaid: 0,
      balanceDue: estimate.total
    };

    // Update customer's outstanding balance
    logger.info(`Updating customer balance for new Invoice ${newInvoiceId}. Amount: ${newInvoice.total}`);
    await db.collection('customers').updateOne(
      { id: newInvoice.customer.id },
      { $inc: { outstandingBalance: newInvoice.total } }
    );

    // Insert the new Invoice
    await db.collection('invoices').insertOne(newInvoice);

    // Update the original Estimate's status
    await db.collection('invoices').updateOne({ id: id }, { $set: { status: 'Converted' } });

    // --- CASHBOOK ENTRY FOR CONVERTED INVOICE ---
    if (newInvoice.total > 0) {
      logger.info(`Attempting to create Sales cashbook entry for converted Invoice ${newInvoice.id}`);
      const salesCategory = await db.collection('cashbook-categories').findOne({ name: 'Sales' });
      if (salesCategory) {
        const lastEntry = await db.collection('cashbook-entries').findOne({}, { sort: { id: -1 } });
        const nextEntryId = lastEntry ? lastEntry.id + 1 : 1;
        const cashbookDateTime = new Date(newInvoice.date); // Use the invoice date
        const salesEntry = {
          id: nextEntryId,
          date: cashbookDateTime.toISOString(),
          categoryId: salesCategory.id,
          description: `Sales from converted Invoice #${newInvoice.id} (Est: ${id}) to ${newInvoice.customer.name}`,
          amount: newInvoice.total,
          type: salesCategory.type
        };
        await db.collection('cashbook-entries').insertOne(salesEntry);
        logger.info(`Created Sales cashbook entry ID ${nextEntryId} for converted Invoice ${newInvoice.id}`);
      } else {
        logger.warn(`Could not create Sales cashbook entry for converted Invoice ${newInvoice.id}: 'Sales' category not found.`);
      }
    }
    // --- END OF CASHBOOK ENTRY ---

    logger.info(`Estimate ${id} successfully converted to Invoice ${newInvoiceId}.`);
    res.status(201).json(newInvoice); // Return the newly created Invoice

  } catch (error) {
    logger.error(`Error converting Estimate ${id}:`, { stack: error.stack });
    res.status(500).json({ message: 'Server error during estimate conversion.' });
  }
});

// --- Purchases ---
app.get('/api/purchases', authenticateToken, async (req, res) => {
  const data = await db.collection('purchases').find({}).sort({ date: 1, id: 1 }).toArray();
  res.json(data);
});

app.post('/api/purchases', authenticateToken, async (req, res) => {
  try {
    const newPurchaseData = req.body;
    const prefix = 'PO-';
    const clientDate = new Date(newPurchaseData.date);
    const fy = getFinancialYearRange(clientDate);

    const lastDoc = await db.collection('purchases').findOne({
      id: { $regex: `^${prefix}` },
      date: {
        $gte: fy.start.toISOString(),
        $lt: fy.end.toISOString()
      }
    }, { sort: { id: -1 } });

    const lastNum = lastDoc ? parseInt(lastDoc.id.split('-')[1]) : 0;
    const newId = `${prefix}${('000' + (lastNum + 1)).slice(-3)}`;
    const finalPurchase = { id: newId, ...newPurchaseData };

    await db.collection('purchases').insertOne(finalPurchase);

    // --- AUTOMATIC CASHBOOK ENTRY FOR PURCHASE ---
    if (finalPurchase.total > 0) {
      const purchaseCategory = await db.collection('cashbook-categories').findOne({ name: 'Purchase' });
      if (purchaseCategory) {
        const lastEntry = await db.collection('cashbook-entries').findOne({}, { sort: { id: -1 } });
        const nextEntryId = lastEntry ? lastEntry.id + 1 : 1;
        const clientDate = new Date(finalPurchase.date); // The date selected by the user
        const now = new Date(); // The current server time
        // Combine the user's date with the server's time
        const finalDateTime = new Date(
          clientDate.getFullYear(),
          clientDate.getMonth(),
          clientDate.getDate(),
          now.getHours(),
          now.getMinutes(),
          now.getSeconds()
        );
        const purchaseEntry = {
          id: nextEntryId,
          date: new Date(finalDateTime).toISOString(),
          categoryId: purchaseCategory.id,
          description: `Purchase from ${finalPurchase.supplier.name} (PO #${finalPurchase.id})`,
          amount: finalPurchase.total,
          type: 'out' // <-- CORRECTED TYPE
        };
        await db.collection('cashbook-entries').insertOne(purchaseEntry);
        logger.info(`Created Purchase cashbook entry for PO ${finalPurchase.id}`);
      } else {
        logger.warn(`Could not create Purchase cashbook entry: 'Purchase' category not found.`);
      }
    }
    // --- END OF NEW LOGIC ---

    res.status(201).json(finalPurchase);
  } catch (error) {
    logger.error('Error creating purchase order:', { stack: error.stack });
    res.status(500).json({ message: 'Server error during purchase order creation.' });
  }
});

app.put('/api/purchases/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const updatedPurchase = req.body;
  const originalPurchase = await db.collection('purchases').findOne({ id: id });
  if (!originalPurchase) return res.status(404).send('Purchase Order not found');

  // If status changed to "Received", update stock
  if (originalPurchase.status !== 'Received' && updatedPurchase.status === 'Received') {
    const bulkOps = updatedPurchase.items.map(item => ({
      updateOne: {
        filter: { id: item.productId },
        update: { $inc: { stock: item.quantity } }
      }
    }));
    if (bulkOps.length > 0) {
      await db.collection('products').bulkWrite(bulkOps);
    }
  }

  const { _id, ...updateData } = updatedPurchase;
  await db.collection('purchases').updateOne({ id: id }, { $set: updateData });
  res.json(updateData);
});

// --- THIS IS THE NEW ENDPOINT TO ADD ---
app.delete('/api/purchases/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.collection('purchases').deleteOne({ id: id });

    if (result.deletedCount === 0) {
      return res.status(404).send('Purchase Order not found');
    }

    res.status(204).send(); // Success, no content to send back
  } catch (error) {
    console.error('Error deleting purchase order:', error);
    res.status(500).json({ message: 'Server error during deletion' });
  }
});


// --- Attendance & Payroll ---
app.get('/api/attendance/:date', authenticateToken, async (req, res) => {
  const data = await db.collection('attendance').find({ date: req.params.date }).toArray();
  res.json(data);
});

app.post('/api/attendancedaywise', authenticateToken, async (req, res) => {
  const dailyRecords = req.body;
  const date = dailyRecords[0]?.date;
  if (!date) return res.status(400).send('Date is required');

  // Atomically delete old records and insert new ones
  await db.collection('attendance').deleteMany({ date: date });
  const result = await db.collection('attendance').insertMany(dailyRecords);
  res.status(201).json(result);
});

app.get('/api/payrolls', authenticateToken, async (req, res) => {
  // Get startDate and endDate from the query parameters
  const { startDate, endDate } = req.query;
  let query = {};

  // If both startDate and endDate are provided, build a filter query
  if (startDate && endDate) {
    logger.info(`Fetching payrolls from ${startDate} to ${endDate}`);
    query = {
      // Filter where the payroll's weekStartDate is within the selected range
      weekStartDate: { $gte: startDate, $lte: endDate }
    };
  } else {
    logger.info('GET /api/payrolls - Fetching all payroll records.');
  }

  // Execute the query (either empty or with a date filter)
  const data = await db.collection('payrolls').find(query).sort({ weekStartDate: -1 }).toArray();
  res.json(data);
});

// --- UPDATED PAYROLL GENERATION ENDPOINT ---
app.post('/api/payrolls/generate', authenticateToken, async (req, res) => {
  // The start date of the week is now passed from the frontend
  const { weekStartDate, bonuses } = req.body;
  if (!weekStartDate) {
    return res.status(400).send('weekStartDate is required.');
  }

  const startDate = new Date(weekStartDate);
  startDate.setUTCHours(0, 0, 0, 0);

  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 5); // Monday to Saturday = 6 days
  endDate.setUTCHours(23, 59, 59, 999);

  const startDateStr = startDate.toISOString().split('T')[0];
  const endDateStr = endDate.toISOString().split('T')[0];
  const employees = await db.collection('employees').find({}).toArray();
  const newPayrolls = [];
  logger.info(`Generating payroll for week: ${startDateStr} to ${endDateStr}`);

  for (const employee of employees) {
    // Find attendance records for this employee within the specified week
    const weeklyAttendance = await db.collection('attendance').find({
      employeeId: employee.id,
      date: { $gte: startDateStr, $lte: endDateStr }
    }).toArray();

    const daysWorked = weeklyAttendance.reduce((total, record) => {
      if (record.status === 'Present') return total + 1;
      if (record.status === 'Half Day') return total + 0.5;
      return total;
    }, 0);

    // Find advances for this employee within the specified week
    const weeklyAdvances = await db.collection('advances').find({
      employeeId: employee.id,
      date: { $gte: startDateStr, $lte: endDateStr }
    }).toArray();

    const totalAdvances = weeklyAdvances.reduce((sum, adv) => sum + adv.amount, 0);
    const grossSalary = daysWorked * employee.dailySalary;
    // Find the specific bonus for this employee from the array sent by the frontend
    const employeeBonus = bonuses ? bonuses.find(b => b.employeeId === employee.id) : null;
    const bonusAmount = employeeBonus ? (Number(employeeBonus.amount) || 0) : 0;
    const bonusDescription = employeeBonus ? employeeBonus.description : undefined;
    logger.info(`Including a bonus of ${bonusAmount} for "${bonusDescription}" to ${employee.name}`);
    // Add the individual bonus to the net salary calculation
    const netSalary = (grossSalary - totalAdvances) + bonusAmount;


    const year = startDate.getFullYear();
    const month = startDate.toLocaleString('default', { month: 'short' }).toUpperCase();
    const weekNumber = Math.ceil((startDate.getDate() + startDate.getDay() + 1) / 7);
    // New ID format: PAY-YYYY-M-WX-EY
    const payrollId = `PAY-${year}-${month}-W${weekNumber}-E${employee.id}`;

    newPayrolls.push({
      id: payrollId,
      weekStartDate: startDateStr, weekEndDate: endDateStr,
      generatedDate: new Date().toISOString(),
      employeeId: employee.id,
      employeeName: employee.name,
      daysWorked, grossSalary,
      advancesDeducted: totalAdvances,
      bonusAmount: bonusAmount,
      bonusDescription: bonusDescription ? bonusDescription : undefined,
      netSalary,
      status: 'Generated', // <-- SET INITIAL STATUS
      amountPaid: 0
    });
  }

  // Atomically delete old payrolls for this week and insert the new ones
  await db.collection('payrolls').deleteMany({ weekStartDate: startDateStr });
  if (newPayrolls.length > 0) {
    await db.collection('payrolls').insertMany(newPayrolls);
  } else {
    console.log(`No payroll records to generate for week starting ${startDateStr}.`);
  }

  res.status(201).json(newPayrolls);
});

// --- NEW: ENDPOINT TO MARK PAYROLL AS PAID ---
app.put('/api/payrolls/:id/pay', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { amountPaid } = req.body;

  if (typeof amountPaid !== 'number') {
    return res.status(400).send('A valid amountPaid is required.');
  }

  console.log(`Updating payroll status for ID: ${id}`);

  const result = await db.collection('payrolls').updateOne(
    { id: id },
    { $set: { status: 'Paid', amountPaid: amountPaid } }
  );

  if (result.matchedCount === 0) {
    console.log(`Payroll record not found for ID: ${id}`);
    return res.status(404).send('Payroll record not found');
  }

  console.log(`Payroll ID: ${id} successfully marked as Paid.`);
  res.status(200).json({ message: 'Payroll updated successfully' });
});


// GET attendance for a specific WEEK (Unchanged)
app.get('/api/attendance/week/:startDate', authenticateToken, async (req, res) => {
  const startDate = new Date(req.params.startDate);
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 6);

  const startDateStr = req.params.startDate;
  const endDateStr = endDate.toISOString().split('T')[0];

  const data = await db.collection('attendance').find({
    date: { $gte: startDateStr, $lte: endDateStr }
  }).toArray();
  res.json(data);
});

// --- THE DEFINITIVE FIX #2: Using Promise.all for granular control ---
app.post('/api/attendance', authenticateToken, async (req, res) => {
  console.log(req.body, 'testing');
  const weeklyRecords = req.body;
  if (!Array.isArray(weeklyRecords) || weeklyRecords.length === 0) {
    return res.status(400).send('Invalid or empty records array provided.');
  }
  console.log(`Received ${weeklyRecords.length} attendance records to process.`);

  try {
    // 1. Create an array of promises, one for each record to be upserted.
    const upsertPromises = weeklyRecords.map(record => {
      const employeeIdAsNumber = Number(record.employeeId);
      if (isNaN(employeeIdAsNumber)) {
        console.warn('Skipping record with invalid employeeId:', record);
        return Promise.resolve(); // Return a resolved promise to not break Promise.all
      }

      console.log(`  -> Upserting: { employeeId: ${employeeIdAsNumber}, date: '${record.date}', status: '${record.status}' }`);

      // Return the promise from the database operation
      return db.collection('attendance').updateOne(
        // Filter to find the unique document
        { employeeId: employeeIdAsNumber, date: record.date },
        // The update to apply
        {
          $set: { status: record.status },
          $setOnInsert: { employeeId: employeeIdAsNumber, date: record.date }
        },
        // The upsert option
        { upsert: true }
      );
    });

    // 2. Execute all the promises concurrently.
    const results = await Promise.all(upsertPromises);
    console.log('All upsert operations completed.');

    // Tally the results for the response
    const matchedCount = results.reduce((sum, r) => sum + (r ? r.matchedCount : 0), 0);
    const upsertedCount = results.reduce((sum, r) => sum + (r ? r.upsertedCount : 0), 0);

    res.status(200).json({
      message: 'Attendance saved successfully.',
      matchedCount: matchedCount,
      upsertedCount: upsertedCount
    });

  } catch (error) {
    console.error('---!! FAILED TO SAVE ATTENDANCE !!---:', error);
    res.status(500).json({ message: 'An error occurred while saving attendance.' });
  }
});


// GET the profile for the currently logged-in user
app.get('/api/profile', authenticateToken, async (req, res) => {
  // The user's ID is available from the token via the authenticateToken middleware
  const userId = req.user.userId;
  logger.info(`GET /api/profile - Fetching profile for user ID: ${userId}`);

  try {
    const user = await db.collection('users').findOne({ id: userId });
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    // Return the profile object, or an empty object if it doesn't exist
    res.json(user.profile || {});
  } catch (error) {
    logger.error(`Error fetching profile for user ID ${userId}:`, { stack: error.stack });
    res.status(500).json({ message: 'Server error while fetching profile.' });
  }
});

// PUT (update) the profile for the currently logged-in user
app.put('/api/profile', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const newProfileData = req.body;
  logger.info(`PUT /api/profile - Updating profile for user ID: ${userId}`);

  try {
    const result = await db.collection('users').updateOne(
      { id: userId },
      { $set: { profile: newProfileData } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: 'User not found.' });
    }
    res.json(newProfileData);
  } catch (error) {
    logger.error(`Error updating profile for user ID ${userId}:`, { stack: error.stack });
    res.status(500).json({ message: 'Server error while updating profile.' });
  }
});


// GET all advances for a specific employee within a specific week
app.get('/api/employees/:employeeId/advances/week/:startDate', authenticateToken, async (req, res) => {
  const { employeeId, startDate } = req.params;
  logger.info(`Fetching advances for employee ${employeeId} for week starting ${startDate}`);

  const start = new Date(startDate);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const endDateStr = end.toISOString().split('T')[0];

  const advances = await db.collection('advances').find({
    employeeId: parseInt(employeeId, 10),
    date: { $gte: startDate, $lte: endDateStr }
  }).sort({ date: -1 }).toArray();

  res.json(advances);
});

// POST a new advance (logic is mostly the same, moved from generic CRUD)
app.post('/api/advances', authenticateToken, async (req, res) => {
  logger.info('POST /api/advances - Creating new advance.');
  const collection = db.collection('advances');
  const newAdvanceData = req.body;
  const lastDoc = await collection.findOne({}, { sort: { id: -1 } });
  newAdvanceData.id = lastDoc ? lastDoc.id + 1 : 1;
  const clientDate = new Date(newAdvanceData.date); // The date selected by the user
  const now = new Date(); // The current server time
  // Combine the user's date with the server's time
  const finalDateTime = new Date(
    clientDate.getFullYear(),
    clientDate.getMonth(),
    clientDate.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds()
  );

  newAdvanceData.date = new Date(finalDateTime).toISOString();
  const result = await collection.insertOne(newAdvanceData);
  res.status(201).json(result);
});

// PUT (update) an existing advance
app.put('/api/advances/:id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id);
  logger.info(`PUT /api/advances/${id} - Updating advance.`);
  const { _id, ...updateData } = req.body;
  const result = await db.collection('advances').updateOne({ id: id }, { $set: updateData });
  if (result.matchedCount === 0) {
    logger.warn(`PUT /api/advances/${id} - Advance not found.`);
    return res.status(404).send('Advance not found');
  }
  res.json(updateData);
});

// DELETE an advance
app.delete('/api/advances/:id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.id);
  logger.info(`DELETE /api/advances/${id} - Deleting advance.`);
  const result = await db.collection('advances').deleteOne({ id: id });
  if (result.deletedCount === 0) {
    logger.warn(`DELETE /api/advances/${id} - Advance not found.`);
    return res.status(404).send('Advance not found');
  }
  res.status(204).send();
});


// --- NEW: BULK PRODUCT IMPORT ENDPOINT ---
app.post('/api/productbulk/bulk', authenticateToken, async (req, res) => {
  const productsToImport = req.body;
  if (!Array.isArray(productsToImport) || productsToImport.length === 0) {
    logger.warn('POST /api/products/bulk - Received invalid or empty array.');
    return res.status(400).send('Product data must be a non-empty array.');
  }

  logger.info(`POST /api/products/bulk - Received ${productsToImport.length} products to import.`);

  try {
    const productsCollection = db.collection('products');
    // Get the last ID to continue the sequence
    const lastDoc = await productsCollection.findOne({}, { sort: { id: -1 } });
    let nextId = lastDoc ? lastDoc.id + 1 : 1;

    // Assign a new sequential ID to each incoming product
    const productsWithIds = productsToImport.map(product => ({
      id: nextId++,
      ...product
    }));

    // Insert all new products in a single database operation
    await productsCollection.insertMany(productsWithIds);

    logger.info(`Successfully bulk-inserted ${productsWithIds.length} products.`);
    res.status(201).json({ message: `${productsWithIds.length} products imported successfully.` });

  } catch (error) {
    logger.error('Failed during bulk product import:', { stack: error.stack });
    res.status(500).json({ message: 'An error occurred during the import process.' });
  }
});

app.put('/api/productbulk/bulk-update', authenticateToken, async (req, res) => {
  const productsToUpdate = req.body;
  if (!Array.isArray(productsToUpdate) || productsToUpdate.length === 0) {
    logger.warn('PUT /api/products/bulk-update - Received invalid or empty array.');
    return res.status(400).send('Product data must be a non-empty array.');
  }

  logger.info(`PUT /api/products/bulk-update - Received ${productsToUpdate.length} products to update.`);

  try {
    const productsCollection = db.collection('products');

    // Create an array of update operations for bulkWrite
    const bulkOps = productsToUpdate.map(product => ({
      updateOne: {
        filter: { id: product.id }, // Find the product by its unique ID
        update: {
          // Use $set to replace the other values
          $set: {
            stock: product.stock,
            hsn: product.hsn,
            priceGst: product.priceGst,
            priceNonGst: product.priceNonGst
          }
        }
      }
    }));

    // Execute all updates in a single database call
    const result = await productsCollection.bulkWrite(bulkOps);

    logger.info(`Successfully processed updates for ${result.modifiedCount} products.`);
    res.status(200).json({ message: `${result.modifiedCount} products updated successfully.` });

  } catch (error) {
    logger.error('Failed during bulk product update:', { stack: error.stack });
    res.status(500).json({ message: 'An error occurred during the update process.' });
  }
});

// --- NEW: BULK TRANSPORTER IMPORT ENDPOINT ---
app.post('/api/transporters/bulk', authenticateToken, async (req, res) => {
  const transportersToImport = req.body;
  if (!Array.isArray(transportersToImport) || transportersToImport.length === 0) {
    logger.warn('POST /api/transporters/bulk - Received invalid or empty array.');
    return res.status(400).send('Transporter data must be a non-empty array.');
  }

  logger.info(`POST /api/transporters/bulk - Received ${transportersToImport.length} transporters to import.`);

  try {
    const transportersCollection = db.collection('transporters');

    // 1. Get all existing phone numbers to prevent duplicates
    const existingPhones = (await transportersCollection.find({}, { projection: { phone: 1 } }).toArray())
      .map(t => t.phone);

    // 2. Get the last ID to continue the sequence
    const lastDoc = await transportersCollection.findOne({}, { sort: { id: -1 } });
    let nextId = lastDoc ? lastDoc.id + 1 : 1;

    const transportersToInsert = [];
    const skippedTransporters = [];

    // 3. Filter out duplicates and assign new IDs
    for (const transporter of transportersToImport) {
      if (!transporter.name || !transporter.phone) {
        skippedTransporters.push({ transporter, reason: 'Missing name or phone' });
        continue;
      }

      if (existingPhones.includes(transporter.phone)) {
        skippedTransporters.push({ transporter, reason: 'Phone number already exists' });
      } else {
        transportersToInsert.push({ id: nextId++, ...transporter });
        existingPhones.push(transporter.phone); // Avoid duplicates within the same batch
      }
    }

    // 4. Insert the new valid transporters
    if (transportersToInsert.length > 0) {
      await transportersCollection.insertMany(transportersToInsert);
      logger.info(`Successfully bulk-inserted ${transportersToInsert.length} transporters.`);
    }

    res.status(201).json({
      message: 'Import complete.',
      created: transportersToInsert.length,
      skipped: skippedTransporters.length,
      skippedDetails: skippedTransporters
    });

  } catch (error) {
    logger.error('Failed during bulk transporter import:', { stack: error.stack });
    res.status(500).json({ message: 'An error occurred during the import process.' });
  }
});
// --- NEW: BULK SUPPLIER IMPORT ENDPOINT ---
app.post('/api/suppliers/bulk', authenticateToken, async (req, res) => {
  const suppliersToImport = req.body;
  if (!Array.isArray(suppliersToImport) || suppliersToImport.length === 0) {
    logger.warn('POST /api/suppliers/bulk - Received invalid or empty array.');
    return res.status(400).send('Supplier data must be a non-empty array.');
  }

  logger.info(`POST /api/suppliers/bulk - Received ${suppliersToImport.length} suppliers to import.`);

  try {
    const suppliersCollection = db.collection('suppliers');

    // 1. Get all existing phone numbers to prevent duplicates
    const existingPhones = (await suppliersCollection.find({}, { projection: { phone: 1 } }).toArray())
      .map(s => s.phone);

    // 2. Get the last ID to continue the sequence
    const lastDoc = await suppliersCollection.findOne({}, { sort: { id: -1 } });
    let nextId = lastDoc ? lastDoc.id + 1 : 1;

    const suppliersToInsert = [];
    const skippedSuppliers = [];

    // 3. Filter out duplicates and assign new IDs
    for (const supplier of suppliersToImport) {
      if (!supplier.name || !supplier.phone) {
        skippedSuppliers.push({ supplier, reason: 'Missing name or phone' });
        continue;
      }

      if (existingPhones.includes(supplier.phone)) {
        skippedSuppliers.push({ supplier, reason: 'Phone number already exists' });
      } else {
        suppliersToInsert.push({ id: nextId++, ...supplier });
        existingPhones.push(supplier.phone); // Avoid duplicates within the same batch
      }
    }

    // 4. Insert the new valid suppliers
    if (suppliersToInsert.length > 0) {
      await suppliersCollection.insertMany(suppliersToInsert);
      logger.info(`Successfully bulk-inserted ${suppliersToInsert.length} suppliers.`);
    }

    res.status(201).json({
      message: 'Import complete.',
      created: suppliersToInsert.length,
      skipped: skippedSuppliers.length,
      skippedDetails: skippedSuppliers
    });

  } catch (error) {
    logger.error('Failed during bulk supplier import:', { stack: error.stack });
    res.status(500).json({ message: 'An error occurred during the import process.' });
  }
});

// --- NEW: SYSTEM RESET API ENDPOINT ---
app.post('/api/system/reset-all-data', authenticateToken, async (req, res) => {
  logger.warn('POST /api/system/reset-all-data - Received request to clear all application data.');
  try {
    const collections = await db.listCollections().toArray();
    for (const collectionInfo of collections) {
      // Important: Do not delete the users collection
      if (collectionInfo.name !== 'users' && collectionInfo.name !== 'products' && collectionInfo.name !== 'categories') {
        logger.info(`Clearing collection: ${collectionInfo.name}`);
        await db.collection(collectionInfo.name).deleteMany({});
      }
    }
    res.status(200).json({ message: 'All application data (except users) has been successfully cleared.' });
  } catch (error) {
    logger.error('Failed to reset data:', { stack: error.stack });
    res.status(500).json({ message: 'An error occurred while clearing data.' });
  }
});

// --- UPDATED: SYSTEM RESET API ENDPOINT ---
app.post('/api/system/reset-data', authenticateToken, async (req, res) => {
  // 1. Get the array of collections to clear from the request body
  const { collectionsToClear } = req.body;

  if (!Array.isArray(collectionsToClear) || collectionsToClear.length === 0) {
    logger.warn('POST /api/system/reset-data - No collections specified to clear.');
    return res.status(400).json({ message: 'Please select at least one data collection to clear.' });
  }

  logger.warn(`POST /api/system/reset-data - Received request to clear data from: ${collectionsToClear.join(', ')}`);

  try {
    for (const collectionName of collectionsToClear) {
      // 2. Safety Check: Never allow the 'users' collection to be cleared via this API.
      if (collectionName !== 'users') {
        // Check if the collection exists before trying to clear it
        const collectionExists = await db.listCollections({ name: collectionName }).hasNext();
        if (collectionExists) {
          logger.info(`Clearing collection: ${collectionName}`);
          await db.collection(collectionName).deleteMany({});
        } else {
          logger.warn(`Collection '${collectionName}' not found, skipping.`);
        }
      } else {
        logger.warn(`Attempt to clear 'users' collection was blocked for security.`);
      }
    }
    res.status(200).json({ message: 'Selected data has been successfully cleared.' });
  } catch (error) {
    logger.error('Failed to reset data:', { stack: error.stack });
    res.status(500).json({ message: 'An error occurred while clearing data.' });
  }
});
