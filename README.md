# ShopGenie AI - WhatsApp Shopping Assistant

> **Last Updated**: 2025-08-22 06:42 UTC

A WhatsApp-based AI shopping assistant that helps users compare prices across multiple grocery delivery platforms and create optimized carts.

## 🚀 Features

- **Price Comparison**: Compare prices across Zepto, Blinkit, and Swiggy Instamart
- **Smart Cart Building**: Select which app to buy each item from
- **Deep Link Checkout**: Direct links to each app with pre-filled carts
- **Address Management**: Validate and store delivery addresses using Google Maps
- **Cart Editing**: Add/remove items mid-conversation
- **AI-Powered Parsing**: Understand natural language shopping requests

## 🛠️ Tech Stack

- **Backend**: Node.js + Express
- **Database**: PostgreSQL (Render)
- **WhatsApp Integration**: Twilio WhatsApp API
- **AI/ML**: OpenAI GPT-4o-mini for natural language processing
- **Maps**: Google Maps Geocoding API
- **Hosting**: Render
- **Security**: Rate limiting, input validation, encrypted sessions

## 📱 User Flow

1. **User sends message**: "Order 2L milk and bread to 123 Main St, Bangalore"
2. **AI parses intent**: Extracts items, quantities, and address
3. **Address validation**: Google Maps API validates and formats address
4. **Price comparison**: Bot fetches prices from multiple platforms
5. **User selection**: User chooses preferred retailer for each item
6. **Cart generation**: Bot creates separate carts per retailer
7. **Deep links**: User gets direct links to complete checkout

## 🏗️ Architecture

```
User (WhatsApp)
     ↓
Twilio WhatsApp API
     ↓
Node.js Express Server
     ↓
├── AI Service (OpenAI)
├── User Service (PostgreSQL)
├── Cart Service (PostgreSQL)
├── WhatsApp Service (Twilio)
└── Address Validation (Google Maps)
     ↓
Deep Links to Retailer Apps
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Twilio account with WhatsApp API
- OpenAI API key
- Google Maps API key

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd shopgenie-ai
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

4. **Database setup**
   ```bash
   npm run migrate
   ```

5. **Start the server**
   ```bash
   npm start
   ```

### Environment Variables

```env
# Twilio WhatsApp
TWILIO_ACCOUNT_SID=your_account_sid
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_WHATSAPP_NUMBER=+14155238886
WEBHOOK_SECRET=your_webhook_secret

# OpenAI
OPENAI_API_KEY=your_openai_key

# Database
DATABASE_URL=postgresql://user:password@host:port/database

# Google Maps
GOOGLE_MAPS_API_KEY=your_google_maps_key

# Security
JWT_SECRET=your_jwt_secret
ENCRYPTION_KEY=your_encryption_key

# App Configuration
APP_BASE_URL=https://your-app.onrender.com
NODE_ENV=production
PORT=8080
```

## 📋 API Endpoints

### WhatsApp Webhook
- `GET /webhook` - Webhook verification
- `POST /webhook` - Incoming WhatsApp messages

### Health Check
- `GET /health` - Basic health check
- `GET /health/detailed` - Detailed system status

### Root
- `GET /` - API information and endpoints

## 🗄️ Database Schema

### Users Table
- `id` - Primary key
- `wa_phone_e164` - WhatsApp phone number
- `display_name` - User's display name
- `allowed` - Whether user can use the service
- `created_at`, `updated_at` - Timestamps

### Addresses Table
- `id` - Primary key
- `user_id` - Foreign key to users
- `raw_input` - Original address input
- `formatted` - Google Maps formatted address
- `lat`, `lng` - Coordinates
- `pincode` - Postal code
- `components` - Address components (JSONB)
- `is_primary`, `confirmed` - Status flags

### Carts Table
- `id` - Primary key
- `user_id` - Foreign key to users
- `status` - Cart status (draft, built, handed_off, ordered, cancelled)
- `retailer_choices` - User's retailer selections (JSONB)
- `deep_links` - Generated deep links (JSONB)

### Cart Items Table
- `id` - Primary key
- `cart_id` - Foreign key to carts
- `query` - Original item query
- `normalized_name` - Standardized item name
- `quantity`, `unit` - Item quantity and unit
- `notes` - Additional notes

### Price Quotes Table
- `id` - Primary key
- `cart_item_id` - Foreign key to cart_items
- `retailer` - Retailer name
- `product_title` - Product name
- `unit_price` - Price in INR
- `currency` - Currency code
- `product_url` - Product URL
- `metadata` - Additional data (JSONB)

### Messages Log Table
- `id` - Primary key
- `user_id` - Foreign key to users
- `message_type` - inbound/outbound
- `content` - Message content
- `metadata` - Additional data (JSONB)

## 🔧 Development

### Running in Development
```bash
npm run dev
```

### Database Migrations
```bash
npm run migrate
```

### Testing
```bash
npm test
```

## 📱 WhatsApp Integration

### Twilio Setup
1. Create a Twilio account
2. Enable WhatsApp Sandbox
3. Get Account SID and Auth Token
4. Configure webhook URL in Twilio console

### Message Flow
1. User sends message to WhatsApp number
2. Twilio forwards to webhook endpoint
3. Server processes message with AI
4. Bot responds via Twilio API

## 🤖 AI Integration

### OpenAI Configuration
- Model: `gpt-4o-mini` (cost-effective)
- Function calling for structured output
- Fallback to regex parsing

### Intent Recognition
- Order items
- Add/remove items
- Address confirmation
- Retailer selection
- Help requests

## 🔒 Security

### Rate Limiting
- 100 requests per 15 minutes per IP
- Configurable limits

### Input Validation
- Joi schema validation
- SQL injection prevention
- XSS protection

### Data Encryption
- Encrypted session storage
- Secure API key handling
- HTTPS enforcement

## 📊 Monitoring

### Health Checks
- Database connectivity
- API service status
- Environment variable validation

### Logging
- Request/response logging
- Error tracking
- Performance metrics

## 🚀 Deployment

### Render Deployment
1. Connect GitHub repository
2. Set environment variables
3. Configure build and start commands
4. Deploy automatically

### Environment Setup
- Production database
- SSL certificates
- Domain configuration
- Monitoring setup

## 📈 Future Enhancements

### Phase 2 Features
- Real-time price scraping
- User authentication
- Payment integration
- Order tracking
- Multi-language support

### Phase 3 Features
- Voice input
- Image recognition
- Predictive ordering
- Loyalty programs
- B2B partnerships

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

For support and questions:
- Create an issue on GitHub
- Contact the development team
- Check the documentation

## 🏆 Acknowledgments

- Twilio for WhatsApp API
- OpenAI for AI capabilities
- Google Maps for address validation
- Render for hosting infrastructure

---

**ShopGenie AI** - Making grocery shopping smarter, one WhatsApp message at a time! 🛒✨ 