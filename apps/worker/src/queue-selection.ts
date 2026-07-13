export const parseQueueSelection = (arguments_: string[]): string[] => {
  const queuesArgument = arguments_.find((argument) =>
    argument.startsWith('--queues='),
  );

  if (queuesArgument === undefined) {
    return [];
  }

  return [
    ...new Set(
      queuesArgument
        .slice('--queues='.length)
        .split(',')
        .map((queue) => queue.trim())
        .filter((queue) => queue.length > 0),
    ),
  ];
};
