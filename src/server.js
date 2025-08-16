require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Import routes
const whatsappRoutes = require('./routes/whatsapp');
const healthRoutes = require('./routes/health');

// Import database
const { initializeDatabase } = require('./database/connection');

const app = express();
const PORT = process.env.PORT || 8080;

// Security middleware
app.use(helmet());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/webhook', whatsappRoutes);
app.use('/health', healthRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'ShopGenie AI WhatsApp Bot',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      webhook: '/webhook',
      health: '/health'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Initialize database and start server
async function startServer() {
  try {
    await initializeDatabase();
    console.log('✅ Database connected successfully');
    
    app.listen(PORT, () => {
      console.log(`🚀 ShopGenie AI server running on port ${PORT}`);
      console.log(`📱 WhatsApp webhook: ${process.env.APP_BASE_URL}/webhook`);
      console.log(`🏥 Health check: ${process.env.APP_BASE_URL}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app; 