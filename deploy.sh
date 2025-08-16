#!/bin/bash

echo "🚀 ShopGenie AI Deployment Script"
echo "=================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18+ is required. Current version: $(node -v)"
    exit 1
fi

echo "✅ Node.js version: $(node -v)"

# Check if .env file exists
if [ ! -f .env ]; then
    echo "❌ .env file not found. Please create it with your credentials."
    echo "Copy .env.example to .env and fill in your values."
    exit 1
fi

echo "✅ .env file found"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

echo "✅ Dependencies installed"

# Test database connection
echo "🗄️ Testing database connection..."
node -e "
const { testConnection } = require('./src/database/connection');
testConnection().then(() => {
    console.log('✅ Database connection successful');
    process.exit(0);
}).catch(err => {
    console.error('❌ Database connection failed:', err.message);
    process.exit(1);
});
"

if [ $? -ne 0 ]; then
    echo "❌ Database connection failed. Please check your DATABASE_URL in .env"
    exit 1
fi

# Initialize database tables
echo "🗄️ Initializing database tables..."
node -e "
const { initializeDatabase } = require('./src/database/connection');
initializeDatabase().then(() => {
    console.log('✅ Database initialized successfully');
    process.exit(0);
}).catch(err => {
    console.error('❌ Database initialization failed:', err.message);
    process.exit(1);
});
"

if [ $? -ne 0 ]; then
    echo "❌ Database initialization failed"
    exit 1
fi

# Test environment variables
echo "🔧 Testing environment variables..."
node -e "
const required = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN', 
    'TWILIO_WHATSAPP_NUMBER',
    'OPENAI_API_KEY',
    'DATABASE_URL',
    'GOOGLE_MAPS_API_KEY'
];

const missing = required.filter(key => !process.env[key]);
if (missing.length > 0) {
    console.error('❌ Missing environment variables:', missing.join(', '));
    process.exit(1);
}

console.log('✅ All required environment variables are set');
process.exit(0);
"

if [ $? -ne 0 ]; then
    echo "❌ Environment variables check failed"
    exit 1
fi

# Start the server
echo "🚀 Starting ShopGenie AI server..."
echo "📱 WhatsApp webhook: $(grep APP_BASE_URL .env | cut -d'=' -f2)/webhook"
echo "🏥 Health check: $(grep APP_BASE_URL .env | cut -d'=' -f2)/health"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

npm start 