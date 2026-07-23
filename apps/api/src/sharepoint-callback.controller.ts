import { createHash } from 'node:crypto';

import {
  Body,
  Controller,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  SHAREPOINT_CALLBACK_MAX_BODY_BYTES,
  SharePointNotificationIntake,
  validateSharePointValidationToken,
} from '@aiflow/connector-microsoft-sharepoint';
import {
  DatabaseService,
  PostgresSharePointRepository,
} from '@aiflow/database';

import type { AuthorizedRequest } from './api-auth';

@Injectable()
export class SharePointCallbackService implements OnApplicationBootstrap {
  private intake?: SharePointNotificationIntake;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  onApplicationBootstrap(): void {
    this.intake = new SharePointNotificationIntake(
      new PostgresSharePointRepository(
        this.database.dataSource,
        this.database.schema,
      ),
    );
  }

  async accept(body: unknown, rawBody: Buffer): Promise<void> {
    if (rawBody.byteLength > SHAREPOINT_CALLBACK_MAX_BODY_BYTES) {
      throw new Error('SHAREPOINT_NOTIFICATION_BODY_TOO_LARGE');
    }
    await this.requireIntake().accept({
      body,
      bodySha256: createHash('sha256').update(rawBody).digest('hex'),
      receivedAt: new Date(),
    });
  }

  private requireIntake(): SharePointNotificationIntake {
    if (this.intake === undefined) {
      throw new Error('SHAREPOINT_NOTIFICATION_INTAKE_NOT_READY');
    }
    return this.intake;
  }
}

@Controller('provider-callbacks/v1/microsoft-graph/sharepoint')
export class SharePointCallbackController {
  constructor(private readonly service: SharePointCallbackService) {}

  @Post()
  async callback(
    @Req() request: AuthorizedRequest,
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const queryKeys = Object.keys(request.query);
    if (queryKeys.includes('validationToken')) {
      if (queryKeys.length !== 1) {
        throw new Error('SHAREPOINT_VALIDATION_TOKEN_INVALID');
      }
      const token = validateSharePointValidationToken(
        request.query.validationToken,
      );
      response
        .status(200)
        .setHeader('Cache-Control', 'no-store')
        .type('text/plain')
        .send(token);
      return;
    }
    if (queryKeys.length > 0) {
      throw new Error('SHAREPOINT_NOTIFICATION_INVALID');
    }
    const contentType = request.headers['content-type'];
    if (
      typeof contentType !== 'string' ||
      contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
    ) {
      throw new Error('SHAREPOINT_NOTIFICATION_CONTENT_TYPE_INVALID');
    }
    if (request.rawBody === undefined) {
      throw new Error('SHAREPOINT_NOTIFICATION_BODY_INVALID');
    }
    await this.service.accept(body, request.rawBody);
    response.status(202).setHeader('Cache-Control', 'no-store').send();
  }
}
