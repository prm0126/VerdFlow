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
} from './app.controllers';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/guard';
import { AvailabilityService } from './availability/availability.service';
import { APP_CONFIG } from './common/tokens';
import type { AppConfig } from './config';
import { DatabaseModule, PG_POOL } from './database/database.module';
import { ErrorsService } from './errors/errors.service';
import { IntakeService } from './intake/intake.service';
import { MastersService } from './masters/masters.service';
import { RotaService } from './rota/rota.service';
import { RulesService } from './rules/rules.service';
import { StudiesService } from './studies/studies.service';
import { UsersService } from './users/users.service';

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
      ],
      providers: [...services, { provide: APP_GUARD, useClass: ThrottlerGuard }, { provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
