import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { fuelRoutes } from './routes/fuel.js';
import { walletRoutes } from './routes/wallet.js';
import { vehicleRoutes } from './routes/vehicles.js';
import { simRoutes } from './routes/sim.js';
import { userRoutes } from './routes/user.js';
import { reportRoutes } from './routes/reports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyStatic, {
    root: join(__dirname, '../public'),
    prefix: '/',
  });

  await app.register(fuelRoutes);
  await app.register(walletRoutes);
  await app.register(vehicleRoutes);
  await app.register(simRoutes);
  await app.register(userRoutes);
  await app.register(reportRoutes);

  return app;
}

// Only run when executed directly (not imported by tests)
if (process.env.NODE_ENV !== 'test') {
  buildApp().then((app) => {
    const port = parseInt(process.env.PORT ?? '3000', 10);
    app.listen({ port, host: '0.0.0.0' }, (err) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
    });
  });
}
