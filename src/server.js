
import Fastify from 'fastify';
import { Kafka } from 'kafkajs';
import { validateLead } from './validators.js';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import client from 'prom-client';


const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();

// Ensure Prisma sees DB_URL even if only DATABASE_URL is provided
if (!process.env.DB_URL && process.env.DATABASE_URL) {
  process.env.DB_URL = process.env.DATABASE_URL; // For schema.prisma env("DB_URL")
}

// API Key for authentication (in production, use environment variable)
const API_KEY = process.env.API_KEY || 'leadflowx-api-key-2025';

// Prometheus metrics
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();
const requestCounter = new client.Counter({
  name: 'ingestion_api_requests_total',
  help: 'Total number of POST /v1/lead requests',
});
const successCounter = new client.Counter({
  name: 'ingestion_api_success_total',
  help: 'Total number of successful lead ingestions',
});
const errorCounter = new client.Counter({
  name: 'ingestion_api_error_total',
  help: 'Total number of failed lead ingestions',
});

// Always-available health endpoint

fastify.get('/health', async (req, reply) => {
  return { status: 'ok' };
});

fastify.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', client.register.contentType);
  reply.send(await client.register.metrics());
});

// Leads listing & dashboard support endpoints (UI compatibility)
fastify.get('/api/leads', async (req, reply) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = Math.min(parseInt(req.query.pageSize) || 25, 200);
  const search = req.query.search;
  const dateFrom = req.query.dateFrom;
  const dateTo = req.query.dateTo;

  const where = {};
  if (search) {
    // Simple OR filter across key text fields
    where.OR = [
      { email: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { company: { contains: search, mode: 'insensitive' } },
      { website: { contains: search, mode: 'insensitive' } }
    ];
  }
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) where.createdAt.lte = new Date(dateTo);
  }

  const total = await prisma.rawLead.count({ where });
  const totalPages = total ? Math.ceil(total / pageSize) : 0;
  const leads = await prisma.rawLead.findMany({
    where,
    orderBy: { id: 'desc' },
    skip: (page - 1) * pageSize,
    take: pageSize
  });

  // Map to UI shape (adding optional fields)
  const data = leads.map(l => ({
    id: l.id,
    email: l.email,
    name: l.name,
    company: l.company,
    website: l.website,
    phone: l.phone,
    correlationId: l.correlationId,
    createdAt: l.createdAt,
    scrapedAt: l.createdAt,
    source: 'google_maps'
  }));

  return {
    success: true,
    data,
    pagination: { page, pageSize, total, totalPages }
  };
});

fastify.get('/api/leads/raw/count', async () => {
  const count = await prisma.rawLead.count();
  return { success: true, data: { count } };
});

fastify.get('/api/leads/by-source', async () => {
  // All current leads considered google_maps; adapt when multi-source persists.
  const count = await prisma.rawLead.count();
  return { success: true, data: [{ source: 'google_maps', count }] };
});

fastify.get('/api/leads/status-funnel', async () => {
  const raw = await prisma.rawLead.count();
  return { success: true, data: { raw, verified: 0, audited: 0, qaPassed: 0, scored: 0 } };
});

let producer = null;

// Authentication middleware
fastify.addHook('preHandler', async (request, reply) => {
  // Skip auth for health and metrics endpoints
  if (request.url === '/health' || request.url === '/metrics') {
    return;
  }
  
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    fastify.log.warn({ event: 'auth_missing', url: request.url, ip: request.ip }, 'Missing or invalid authorization header');
    return reply.code(401).send({ error: 'Missing or invalid authorization header' });
  }
  
  const token = authHeader.substring(7);
  if (token !== API_KEY) {
    fastify.log.warn({ event: 'auth_failed', url: request.url, ip: request.ip }, 'Invalid API key');
    return reply.code(401).send({ error: 'Invalid API key' });
  }
  
  fastify.log.info({ event: 'auth_success', url: request.url }, 'API authentication successful');
});

// Register all routes before any async logic

fastify.post('/v1/lead', async (req, reply) => {
  requestCounter.inc();
  const errors = validateLead(req.body);
  if (errors) {
    errorCounter.inc();
    fastify.log.warn({ event: 'validation_failed', errors, body: req.body }, 'Lead validation failed');
    return reply.code(400).send({ errors });
  }

  // Generate correlation ID
  const correlationId = uuidv4();
  const leadData = { ...req.body, correlationId };
  fastify.log.info({ event: 'correlation_id_generated', correlationId }, 'Generated correlation ID for new lead');

  try {
    // Duplicate check
    const existing = await prisma.rawLead.findFirst({
      where: {
        OR: [
          { email: req.body.email },
          { company: req.body.company },
          { website: req.body.website }
        ]
      }
    });
    if (existing) {
      errorCounter.inc();
      fastify.log.warn({ event: 'duplicate_lead', correlationId, lead: req.body }, 'Duplicate lead detected');
      return reply.code(409).send({ error: 'Duplicate lead detected' });
    }

    // Save lead to Postgres using Prisma
    const lead = await prisma.rawLead.create({
      data: leadData
    });
    fastify.log.info({ event: 'lead_saved', correlationId, leadId: lead.id }, 'Lead saved to database');

    if (!producer) {
      errorCounter.inc();
      fastify.log.error({ event: 'kafka_producer_not_ready', correlationId }, 'Kafka producer not ready');
      return reply.code(503).send({ error: 'Kafka producer not ready' });
    }

    try {
      await producer.send({
        topic: 'lead.raw',
        messages: [{ value: JSON.stringify(leadData), headers: { correlationId } }]
      });
      successCounter.inc();
      fastify.log.info({ event: 'lead_published', correlationId, leadId: lead.id }, 'Lead published to Kafka');
      return { status: 'accepted', lead };
    } catch (err) {
      // Publish to DLQ if Kafka fails
      await producer.send({
        topic: 'lead.dlq',
        messages: [{ value: JSON.stringify(leadData), headers: { correlationId } }]
      });
      errorCounter.inc();
      fastify.log.error({ event: 'kafka_publish_failed', correlationId, error: err.message }, 'Failed to publish to Kafka, sent to DLQ');
      return reply.code(500).send({ error: 'Failed to publish to Kafka', details: err.message });
    }
  } catch (err) {
    errorCounter.inc();
    fastify.log.error({ event: 'database_error', correlationId, error: err.message, stack: err.stack }, 'Database operation failed');
    return reply.code(500).send({ error: 'Database operation failed', details: err.message });
  }
});

const start = async () => {
  try {
    const kafka = new Kafka({ brokers: ['kafka:9092'] });
    producer = kafka.producer();
    await producer.connect();
    fastify.log.info('Kafka producer connected');
  } catch (err) {
    fastify.log.error('Failed to connect Kafka producer:', err);
    // Producer remains null, /health still works
  }
  
  try {
    await fastify.listen({ port: 8080, host: '0.0.0.0' });
    fastify.log.info('Server listening at http://0.0.0.0:8080');
  } catch (err) {
    fastify.log.error('Error starting server:', err);
    process.exit(1);
  }
};

// ...existing code...
// Graceful shutdown for Prisma
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

start();
