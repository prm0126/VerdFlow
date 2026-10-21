import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AuthService, type SessionUser } from './auth/auth.service';
import { CurrentUser, Public, RequirePermission, SESSION_COOKIE } from './auth/guard';
import { AvailabilityService } from './availability/availability.service';
import { APP_CONFIG } from './common/tokens';
import type { AppConfig } from './config';
import { PG_POOL } from './database/database.module';
import { many } from './database/db';
import { ErrorsService } from './errors/errors.service';
import { IntakeService } from './intake/intake.service';
import { MasterError, MastersService, type MasterKind } from './masters/masters.service';
import { RuleError, RulesService } from './rules/rules.service';
import { RotaError, RotaService } from './rota/rota.service';
import { Conflict, NotFound, StudiesService } from './studies/studies.service';
import { UserError, UsersService } from './users/users.service';
import { VettingService } from './vetting/vetting.service';
import { PeerReviewService } from './workflow/peer-review';
import { EscalationsService } from './workflow/timers';

/** Maps service errors to HTTP responses with plain-English messages. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NotFound) throw new NotFoundException('Not found');
    if (err instanceof Conflict) throw new ConflictException(err.message);
    if (err instanceof MasterError) throw new BadRequestException({ message: err.message, issues: err.issues });
    if (err instanceof RotaError || err instanceof UserError) throw new BadRequestException(err.message);
    if (err instanceof RuleError) {
      if (err.status === 404) throw new NotFoundException(err.message);
      if (err.status === 403) throw new ForbiddenException(err.message);
      if (err.status === 409) throw new ConflictException(err.message);
      throw new BadRequestException({ message: err.message, issues: err.issues });
    }
    throw err;
  }
}

const loginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (req.header('x-requested-with') !== 'verdflow') throw new ForbiddenException('Missing request header');
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException('Email or password is incorrect');
    const result = await this.auth.login(parsed.data.email, parsed.data.password, req.ip, req.header('user-agent'));
    if (!result) throw new UnauthorizedException('Email or password is incorrect, or the account is locked. Try again in 15 minutes.');
    res.cookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.cookieSecure,
      maxAge: this.config.sessionHours * 3600_000,
      path: '/',
    });
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser() user: SessionUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user.sessionId, user.id);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: SessionUser) {
    return { id: user.id, email: user.email, fullName: user.fullName, roles: user.roles, permissions: user.permissions };
  }
}

/** Set-password links. Public: the single-use token is the credential. */
@Controller('auth/password-link')
export class PasswordLinkController {
  constructor(private readonly users: UsersService) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  async check(@Param('token') token: string) {
    const user = await this.users.checkLink(token);
    if (!user) throw new NotFoundException('This link has expired or has already been used. Ask an administrator for a new one.');
    return user;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':token')
  @HttpCode(200)
  set(@Param('token') token: string, @Body() body: { password?: string }, @Req() req: Request) {
    if (req.header('x-requested-with') !== 'verdflow') throw new ForbiddenException('Missing request header');
    return run(() => this.users.setPassword(token, String(body?.password ?? ''), req.ip));
  }
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermission('users.manage')
  @Get()
  list() {
    return this.users.list();
  }

  @RequirePermission('users.manage')
  @Post()
  create(@Body() body: unknown, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.users.create(body, user.id, req.ip));
  }

  @RequirePermission('users.manage')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.users.update(id, body, user.id, req.ip));
  }

  @RequirePermission('users.manage')
  @Post(':id/password-link')
  @HttpCode(200)
  link(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.users.newLink(id, user.id, req.ip));
  }
}

@Controller('rota')
export class RotaController {
  constructor(private readonly rota: RotaService) {}

  @RequirePermission('studies.view')
  @Get()
  week(@Query('from') from: string, @Query('to') to: string) {
    return run(() => this.rota.week(from, to));
  }

  @RequirePermission('availability.manage')
  @Post('shifts')
  addShift(@Body() body: unknown, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.rota.addShift(body, user.id, req.ip));
  }

  @RequirePermission('availability.manage')
  @Post('shifts/:id/delete')
  @HttpCode(200)
  deleteShift(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.rota.deleteShift(id, user.id, req.ip));
  }

  @RequirePermission('availability.manage')
  @Post('absences')
  addAbsence(@Body() body: unknown, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.rota.addAbsence(body, user.id, req.ip));
  }

  @RequirePermission('availability.manage')
  @Post('absences/:id/end')
  @HttpCode(200)
  endAbsence(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.rota.endAbsence(id, user.id, req.ip));
  }

  @RequirePermission('availability.manage')
  @Post('radiologists/:id/break')
  @HttpCode(200)
  breakAction(@Param('id', ParseUUIDPipe) id: string, @Body() body: { action?: string }, @CurrentUser() user: SessionUser, @Req() req: Request) {
    if (body?.action === 'start') return run(() => this.rota.startBreak(id, user.id, req.ip));
    if (body?.action === 'end') return run(() => this.rota.endBreak(id, user.id, req.ip));
    throw new BadRequestException('action must be start or end');
  }
}

/** Partner-facing endpoints. Authenticated by the partner's API key, not a user session. */
@Controller('integration')
export class IntegrationController {
  constructor(
    private readonly intake: IntakeService,
    private readonly availability: AvailabilityService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 6000, ttl: 60_000 } })
  @Post('hl7')
  @Header('content-type', 'x-application/hl7-v2+er7; charset=utf-8')
  async hl7(@Req() req: Request, @Res() res: Response) {
    const key = bearer(req);
    const body = typeof req.body === 'string' ? req.body : '';
    const result = await this.intake.receive(key, body);
    res.status(result.httpStatus).send(result.ack);
  }

  @Public()
  @Post('presence')
  @HttpCode(200)
  async presence(@Req() req: Request, @Body() body: unknown) {
    const partner = await this.intake.authenticate(bearer(req));
    if (!partner) throw new UnauthorizedException('Not authorised');
    if (partner.role !== 'presence') throw new ForbiddenException('This partner may not send presence');
    const parsed = z.object({ radiologistCodes: z.array(z.string().max(30)).max(1000) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException('radiologistCodes must be a list of codes');
    return this.availability.heartbeat(parsed.data.radiologistCodes);
  }
}

function bearer(req: Request): string | undefined {
  const h = req.header('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

@Controller()
export class StudiesController {
  constructor(private readonly studies: StudiesService) {}

  @RequirePermission('dashboard.view')
  @Get('dashboard')
  dashboard() {
    return this.studies.dashboard();
  }

  @RequirePermission('studies.view')
  @Get('studies')
  list(@Query('state') state: string | undefined, @Query('q') q: string | undefined, @CurrentUser() user: SessionUser) {
    return this.studies.list({ state, q }, user.permissions.includes('phi.view'));
  }

  @RequirePermission('studies.view')
  @Get('studies/:id')
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return run(() => this.studies.detail(id, user.permissions.includes('phi.view')));
  }

  @RequirePermission('hl7.raw.view')
  @Get('messages/:kind/:id/raw')
  async raw(@Param('kind') kind: string, @Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser, @Req() req: Request) {
    if (kind !== 'intake' && kind !== 'outbound') throw new NotFoundException('Not found');
    return { payload: await run(() => this.studies.rawMessage(kind, id, user.id, req.ip)) };
  }

  @RequirePermission('errors.manage')
  @Post('studies/:id/reallocate')
  @HttpCode(200)
  reallocate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.studies.reallocate(id, user.id, req.ip));
  }

  @RequirePermission('errors.manage')
  @Post('studies/:id/reassign')
  @HttpCode(200)
  reassign(@Param('id', ParseUUIDPipe) id: string, @Body() body: { reason?: string }, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.studies.reassign(id, String(body?.reason ?? ''), user.id, req.ip));
  }

  @RequirePermission('errors.manage')
  @Post('studies/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body() body: { reason?: string }, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.studies.cancel(id, String(body?.reason ?? ''), user.id, req.ip));
  }
}

@Controller('errors')
export class ErrorsController {
  constructor(private readonly errors: ErrorsService) {}

  @RequirePermission('errors.manage')
  @Get()
  list() {
    return this.errors.list();
  }

  @RequirePermission('errors.manage')
  @Post('intake/:id/requeue')
  @HttpCode(200)
  requeue(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.errors.requeueIntake(id, user.id, req.ip));
  }

  @RequirePermission('errors.manage')
  @Post('outbound/:id/retry')
  @HttpCode(200)
  retry(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.errors.retryOutbound(id, user.id, req.ip));
  }

  @RequirePermission('errors.manage')
  @Post('collisions/:id/resolve')
  @HttpCode(200)
  resolve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.errors.resolveCollision(id, user.id, req.ip));
  }
}

@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @RequirePermission('studies.view')
  @Get()
  list() {
    return this.availability.list();
  }

  @RequirePermission('availability.manage')
  @Put(':radiologistId')
  async set(
    @Param('radiologistId', ParseUUIDPipe) id: string,
    @Body() body: { status?: string; capacityUnits?: number },
    @CurrentUser() user: SessionUser,
    @Req() req: Request,
  ) {
    try {
      const r = await this.availability.setStatus(id, String(body?.status ?? ''), body?.capacityUnits, user.id, req.ip);
      if (!r) throw new NotFoundException('Radiologist not found');
      return r;
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw new BadRequestException((err as Error).message);
    }
  }
}

@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @RequirePermission('studies.view')
  @Get()
  list() {
    return this.rules.list();
  }

  @RequirePermission('studies.view')
  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const r = await this.rules.get(id);
    if (!r) throw new NotFoundException('Rule set not found');
    return r;
  }

  @RequirePermission('rules.author')
  @Post('validate')
  @HttpCode(200)
  validate(@Body() body: { definition?: unknown }) {
    return run(async () => ({ ok: true, definition: await this.rules.validate(body?.definition) }));
  }

  @RequirePermission('rules.author')
  @Post()
  create(@Body() body: { definition?: unknown; note?: string }, @CurrentUser() user: SessionUser) {
    return run(() => this.rules.createDraft(body?.definition, body?.note, user.id));
  }

  @RequirePermission('rules.author')
  @Put(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: { definition?: unknown; note?: string }, @CurrentUser() user: SessionUser) {
    return run(() => this.rules.updateDraft(id, body?.definition, body?.note, user.id));
  }

  @RequirePermission('rules.author')
  @Post(':id/submit')
  @HttpCode(200)
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser) {
    return run(() => this.rules.submit(id, user.id));
  }

  @RequirePermission('rules.approve')
  @Post(':id/decision')
  @HttpCode(200)
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() body: { approve?: boolean; note?: string }, @CurrentUser() user: SessionUser) {
    return run(() => this.rules.decide(id, body?.approve === true, body?.note, user.id));
  }
}

const MASTER_KINDS: MasterKind[] = ['hospitals', 'rooms', 'modalities', 'services', 'teams', 'employees', 'radiologists', 'partners'];

function masterKind(kind: string): MasterKind {
  if (!(MASTER_KINDS as string[]).includes(kind)) throw new NotFoundException('Not found');
  return kind as MasterKind;
}

@Controller('masters')
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  @RequirePermission('studies.view')
  @Get(':kind')
  list(@Param('kind') kind: string) {
    return this.masters.list(masterKind(kind));
  }

  @RequirePermission('masters.manage')
  @Put(':kind')
  save(@Param('kind') kind: string, @Body() body: unknown, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.masters.save(masterKind(kind), body, user.id, req.ip));
  }

  @RequirePermission('masters.manage')
  @Post('partners/:code/rotate-key')
  @HttpCode(200)
  rotate(@Param('code') code: string, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.masters.rotatePartnerKey(code, user.id, req.ip));
  }
}

@Controller('audit')
export class AuditController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @RequirePermission('audit.view')
  @Get()
  list(@Query('entityId') entityId?: string) {
    return many(
      this.pool,
      `SELECT a.id, a.occurred_at, a.actor_type, a.actor_id, u.full_name AS actor_name, a.action, a.entity_type, a.entity_id, a.detail
         FROM audit_events a LEFT JOIN users u ON a.actor_type = 'user' AND u.id::text = a.actor_id
        WHERE ($1::text IS NULL OR a.entity_id = $1)
        ORDER BY a.id DESC LIMIT 300`,
      [entityId?.slice(0, 100) || null],
    );
  }
}

@Controller('vetting')
export class VettingController {
  constructor(private readonly vetting: VettingService) {}

  @RequirePermission('vetting.perform')
  @Get()
  list() {
    return this.vetting.list();
  }

  @RequirePermission('vetting.perform')
  @Post(':studyId')
  @HttpCode(200)
  decide(@Param('studyId', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.vetting.decide(id, body, user.id, req.ip));
  }
}

@Controller('escalations')
export class EscalationsController {
  constructor(private readonly escalations: EscalationsService) {}

  @RequirePermission('studies.view')
  @Get()
  list(@Query('all') all?: string) {
    return this.escalations.list(all === 'true');
  }

  @RequirePermission('escalations.manage')
  @Post(':id/acknowledge')
  @HttpCode(200)
  acknowledge(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.escalations.acknowledge(id, user.id, req.ip));
  }
}

@Controller('peer-review')
export class PeerReviewController {
  constructor(private readonly reviews: PeerReviewService) {}

  @RequirePermission('studies.view')
  @Get()
  list(@Query('mine') mine: string | undefined, @Query('status') status: string | undefined, @CurrentUser() user: SessionUser) {
    return this.reviews.list({ mine: mine === 'true' ? user.id : undefined, status: status || undefined });
  }

  @RequirePermission('studies.view')
  @Get('summary')
  summary() {
    return this.reviews.summary();
  }

  @RequirePermission('review.perform')
  @Post(':id')
  @HttpCode(200)
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @CurrentUser() user: SessionUser, @Req() req: Request) {
    return run(() => this.reviews.complete(id, body, user.id, req.ip));
  }
}
