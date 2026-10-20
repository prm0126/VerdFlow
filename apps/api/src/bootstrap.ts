import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { AppConfig } from './config';

export async function createApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bodyParser: false,
    logger: process.env.NODE_ENV === 'test' ? false : ['error', 'warn', 'log'],
  });
  app.set('trust proxy', 'loopback');
  app.use(helmet());
  app.use(cookieParser());
  // HL7 arrives as raw text, whatever content type the sender's Mirth channel uses.
  app.use('/api/integration/hl7', express.text({ type: () => true, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}
