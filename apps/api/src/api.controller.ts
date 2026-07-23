import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';

import type { AuthorizedRequest } from './api-auth';
import { requireAuthorization } from './api-auth';
import { ApiService } from './api.service';

@Controller('api/v1')
export class ApiController {
  constructor(@Inject(ApiService) private readonly service: ApiService) {}

  @Get('connectors')
  connectors(
    @Req() request: AuthorizedRequest,
    @Query('capability') capability: string | undefined,
  ) {
    requireAuthorization(request);
    return {
      data: this.service.connectorCatalog(capability),
      page: { nextCursor: null },
    };
  }

  @Get('connectors/:connectorId')
  connector(
    @Req() request: AuthorizedRequest,
    @Param('connectorId') connectorId: string,
  ) {
    requireAuthorization(request);
    return { data: this.service.connectorDescriptor(connectorId) };
  }

  @Get('extraction-profiles')
  extractionProfiles(@Req() request: AuthorizedRequest) {
    requireAuthorization(request);
    return {
      data: this.service.extractionProfileCatalog(),
      page: { nextCursor: null },
    };
  }

  @Get('extraction-profiles/:profileId')
  extractionProfile(
    @Req() request: AuthorizedRequest,
    @Param('profileId') profileId: string,
  ) {
    requireAuthorization(request);
    return { data: this.service.extractionProfileDescriptor(profileId) };
  }

  @Post('connections')
  async createConnection(
    @Req() request: AuthorizedRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.createConnection(
        requireAuthorization(request),
        body,
        idempotencyKey,
      ),
    };
  }

  @Get('connections')
  async listConnections(
    @Req() request: AuthorizedRequest,
    @Query('connectorId') connectorId: string | undefined,
  ) {
    return {
      data: await this.service.listConnections(
        requireAuthorization(request),
        connectorId,
      ),
      page: { nextCursor: null },
    };
  }

  @Get('connections/:connectionId')
  async getConnection(
    @Req() request: AuthorizedRequest,
    @Param('connectionId') connectionId: string,
  ) {
    return {
      data: await this.service.getConnection(
        requireAuthorization(request),
        connectionId,
      ),
    };
  }

  @Patch('connections/:connectionId')
  async updateConnection(
    @Req() request: AuthorizedRequest,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.updateConnection(
        requireAuthorization(request),
        connectionId,
        body,
        idempotencyKey,
      ),
    };
  }

  @Delete('connections/:connectionId')
  async revokeConnection(
    @Req() request: AuthorizedRequest,
    @Param('connectionId') connectionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.revokeConnection(
        requireAuthorization(request),
        connectionId,
        idempotencyKey,
      ),
    };
  }

  @Post('projects/:projectId/workflows')
  async createWorkflow(
    @Req() request: AuthorizedRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.createWorkflow(
        requireAuthorization(request),
        projectId,
        body,
        idempotencyKey,
      ),
    };
  }

  @Get('projects/:projectId/workflows')
  async listWorkflows(
    @Req() request: AuthorizedRequest,
    @Param('projectId') projectId: string,
  ) {
    return {
      data: await this.service.listWorkflows(
        requireAuthorization(request),
        projectId,
      ),
      page: { nextCursor: null },
    };
  }

  @Get('workflows/:workflowId')
  async getWorkflow(
    @Req() request: AuthorizedRequest,
    @Param('workflowId') workflowId: string,
  ) {
    return {
      data: await this.service.getWorkflow(
        requireAuthorization(request),
        workflowId,
      ),
    };
  }

  @Delete('workflows/:workflowId')
  async archiveWorkflow(
    @Req() request: AuthorizedRequest,
    @Param('workflowId') workflowId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.archiveWorkflow(
        requireAuthorization(request),
        workflowId,
        idempotencyKey,
      ),
    };
  }

  @Post('workflows/:workflowId/versions')
  async createWorkflowVersion(
    @Req() request: AuthorizedRequest,
    @Param('workflowId') workflowId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.createWorkflowVersion(
        requireAuthorization(request),
        workflowId,
        body,
        idempotencyKey,
      ),
    };
  }

  @Get('workflows/:workflowId/versions')
  async listWorkflowVersions(
    @Req() request: AuthorizedRequest,
    @Param('workflowId') workflowId: string,
  ) {
    return {
      data: await this.service.listWorkflowVersions(
        requireAuthorization(request),
        workflowId,
      ),
      page: { nextCursor: null },
    };
  }

  @Get('workflows/:workflowId/versions/:versionId')
  async getWorkflowVersion(
    @Req() request: AuthorizedRequest,
    @Param('workflowId') workflowId: string,
    @Param('versionId') versionId: string,
  ) {
    return {
      data: await this.service.getWorkflowVersion(
        requireAuthorization(request),
        workflowId,
        versionId,
      ),
    };
  }

  @Put('workflows/:workflowId/activation')
  @HttpCode(202)
  async activateWorkflow(
    @Req() request: AuthorizedRequest,
    @Param('workflowId') workflowId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.activateWorkflow(
        requireAuthorization(request),
        workflowId,
        body,
        idempotencyKey,
      ),
    };
  }

  @Get('workflows/:workflowId/activation')
  async getActivation(
    @Req() request: AuthorizedRequest,
    @Param('workflowId') workflowId: string,
  ) {
    return {
      data: await this.service.getActivation(
        requireAuthorization(request),
        workflowId,
      ),
    };
  }

  @Delete('workflows/:workflowId/activation')
  @HttpCode(200)
  async deactivateWorkflow(
    @Req() request: AuthorizedRequest,
    @Param('workflowId') workflowId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.deactivateWorkflow(
        requireAuthorization(request),
        workflowId,
        idempotencyKey,
      ),
    };
  }

  @Get('provisioning-operations/:operationId')
  async getOperation(
    @Req() request: AuthorizedRequest,
    @Param('operationId') operationId: string,
  ) {
    return {
      data: await this.service.getOperation(
        requireAuthorization(request),
        operationId,
      ),
    };
  }

  @Post('workflows/:workflowId/upload-sessions')
  async createUpload(
    @Req() request: AuthorizedRequest,
    @Param('workflowId') workflowId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.createUpload(
        requireAuthorization(request),
        workflowId,
        body,
        idempotencyKey,
      ),
    };
  }

  @Post(
    'upload-sessions/:uploadSessionId/parts/:partNumber/upload-capabilities',
  )
  async issuePart(
    @Req() request: AuthorizedRequest,
    @Param('uploadSessionId') uploadSessionId: string,
    @Param('partNumber', ParseIntPipe) partNumber: number,
    @Body() body: unknown,
  ) {
    return {
      data: await this.service.issuePart(
        requireAuthorization(request),
        uploadSessionId,
        partNumber,
        body,
      ),
    };
  }

  @Post('upload-sessions/:uploadSessionId/complete')
  async completeUpload(
    @Req() request: AuthorizedRequest,
    @Param('uploadSessionId') uploadSessionId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.completeUpload(
        requireAuthorization(request),
        uploadSessionId,
        body,
        idempotencyKey,
      ),
    };
  }

  @Delete('upload-sessions/:uploadSessionId')
  @HttpCode(200)
  async abortUpload(
    @Req() request: AuthorizedRequest,
    @Param('uploadSessionId') uploadSessionId: string,
  ) {
    return {
      data: await this.service.abortUpload(
        requireAuthorization(request),
        uploadSessionId,
      ),
    };
  }

  @Get('workflows/:workflowId/executions')
  async listExecutions(
    @Req() request: AuthorizedRequest,
    @Param('workflowId') workflowId: string,
  ) {
    return {
      data: await this.service.listExecutions(
        requireAuthorization(request),
        workflowId,
      ),
      page: { nextCursor: null },
    };
  }

  @Get('executions/:executionId')
  async getExecution(
    @Req() request: AuthorizedRequest,
    @Param('executionId') executionId: string,
  ) {
    return {
      data: await this.service.getExecution(
        requireAuthorization(request),
        executionId,
      ),
    };
  }

  @Post('executions/:executionId/retries')
  async retryExecution(
    @Req() request: AuthorizedRequest,
    @Param('executionId') executionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return {
      data: await this.service.retryExecution(
        requireAuthorization(request),
        executionId,
        idempotencyKey,
      ),
    };
  }

  @Post('callbacks/extraction/fake-extraction')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  async extractionCallback(
    @Req() request: AuthorizedRequest,
    @Headers('x-aiflow-signature') signature: string | undefined,
    @Headers('x-aiflow-timestamp') timestamp: string | undefined,
  ) {
    if (request.rawBody === undefined) {
      throw new Error('EXTRACTION_CALLBACK_INVALID');
    }
    return {
      data: {
        outcome: await this.service.acceptExtractionCallback(
          request.rawBody,
          signature,
          timestamp,
        ),
      },
    };
  }
}
