import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from '@vf/shared';
import type { Request } from 'express';
import { AuthService, type SessionUser } from './auth.service';

export const SESSION_COOKIE = 'vf_session';
const PUBLIC = 'vf:public';
const PERMISSION = 'vf:permission';

/** Skips user-session checks. Integration endpoints use partner keys instead. */
export const Public = () => SetMetadata(PUBLIC, true);
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION, p);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionUser => {
  return ctx.switchToHttp().getRequest<Request & { user: SessionUser }>().user;
});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Every route needs a signed-in user unless marked @Public. State-changing requests must carry the
 * X-Requested-With header, which a cross-site form cannot send without a CORS preflight.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    if (!SAFE_METHODS.has(req.method) && req.header('x-requested-with') !== 'verdflow') {
      throw new ForbiddenException('Missing request header');
    }
    const user = await this.auth.resolve(req.cookies?.[SESSION_COOKIE]);
    if (!user) throw new UnauthorizedException('Please sign in');
    req.user = user;
    const needed = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, targets);
    if (needed && !user.permissions.includes(needed)) throw new ForbiddenException('You do not have permission to do this');
    return true;
  }
}
