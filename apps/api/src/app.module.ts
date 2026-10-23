import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { Pool } from 'pg';
import {
  AuditController,
  AuthController,
  AvailabilityController,
  ErrorsController,
  IntegrationController,
  MastersController,
  PasswordLinkController,
  RotaController,
  RulesController,
  StudiesController,
  UsersController,
  VettingController,
  EscalationsController,
  PeerReviewController,
  OpsController,
  AssistantController,
  MessagesController,
} from './app.controllers';
import { AssistantService } from './assistant/assistant.service';
import { MessagesService } from './messages/messages.service';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/guard';
import { AvailabilityService } from './availability/availability.service';
import { APP_CONFIG, METRICS } from './common/tokens';
import { createMetrics } from './ops/metrics';
import type { AppConfig } from './config';
import { DatabaseModule, PG_POOL } from './database/database.module';
import { ErrorsService } from './errors/errors.service';
import { IntakeService } from './intake/intake.service';
import { MastersService } from './masters/masters.service';
import { RotaService } from './rota/rota.service';
import { RulesService } from './rules/rules.service';
import { StudiesService } from './studies/studies.service';
import { UsersService } from './users/users.service';
import { VettingService } from './vetting/vetting.service';
import { PeerReviewService } from './workflow/peer-review';
import { EscalationsService } from './workflow/timers';

/** The services are plain classes so the worker and tests can use them without Nest. */
const services = [
  { provide: AuthService, deps: true },
  { provide: AvailabilityService, deps: true },
  { provide: StudiesService, deps: true },
  { provide: IntakeService, deps: false },
  { provide: ErrorsService, deps: false },
  { provide: MastersService, deps: false },
  { provide: RulesService, deps: false },
  { provide: RotaService, deps: false },
  { provide: UsersService, deps: false },
  { provide: VettingService, deps: true },
  { provide: EscalationsService, deps: false },
  { provide: PeerReviewService, deps: false },
  { provide: AssistantService, deps: true },
  { provide: MessagesService, deps: false },
].map(({ provide, deps }) => ({
  provide,
  inject: [PG_POOL, APP_CONFIG],
  useFactory: (pool: Pool, config: AppConfig) =>
    deps ? new (provide as new (p: Pool, c: AppConfig) => unknown)(pool, config) : new (provide as new (p: Pool) => unknown)(pool),
}));

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const configModule: DynamicModule = {
      module: class ConfigModule {},
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
    return {
      module: AppModule,
      imports: [configModule, DatabaseModule, ThrottlerModule.forRoot([{ ttl: 60_000, limit: 600 }])],
      controllers: [
        AuthController,
        PasswordLinkController,
        UsersController,
        RotaController,
        IntegrationController,
        StudiesController,
        ErrorsController,
        AvailabilityController,
        RulesController,
        MastersController,
        AuditController,
        VettingController,
        EscalationsController,
        PeerReviewController,
        OpsController,
        AssistantController,
        MessagesController,
      ],
      providers: [
        ...services,
        { provide: METRICS, inject: [PG_POOL, APP_CONFIG], useFactory: (pool: Pool, c: AppConfig) => createMetrics(pool, c.presenceStaleSeconds) },
        { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
