export const SERVICE_NAME = 'aiflow-engine';

export type RuntimeRole = 'api' | 'worker' | 'scheduler';

export * from './correlation-id';
export * from './request-context';

export const waitForTerminationSignal = (): Promise<NodeJS.Signals> =>
  new Promise((resolve) => {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    const keepAlive = setInterval(() => undefined, 60_000);

    const onSignal = (signal: NodeJS.Signals): void => {
      clearInterval(keepAlive);

      for (const registeredSignal of signals) {
        process.removeListener(registeredSignal, onSignal);
      }

      resolve(signal);
    };

    for (const signal of signals) {
      process.once(signal, onSignal);
    }
  });
