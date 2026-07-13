const DEFAULT_API_HOST = '0.0.0.0';
const DEFAULT_API_PORT = 3000;

export interface ApiRuntimeConfig {
  host: string;
  port: number;
}

const readPort = (value: string | undefined): number => {
  if (value === undefined || value.length === 0) {
    return DEFAULT_API_PORT;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('API_PORT must be an integer between 1 and 65535');
  }

  return port;
};

export const loadApiRuntimeConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): ApiRuntimeConfig => ({
  host: environment.API_HOST?.trim() || DEFAULT_API_HOST,
  port: readPort(environment.API_PORT),
});
