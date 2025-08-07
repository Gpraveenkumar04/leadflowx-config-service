
import Fastify from 'fastify';
import { Kafka } from 'kafkajs';
import { validateLead } from './validators.js';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import client from 'prom-client';


const fastify = Fastify({ logger: true });
const prisma = new PrismaClient();

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
