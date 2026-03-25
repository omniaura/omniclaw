import { useEventSource, type ConnectionStatus } from '~/lib/event-source';

const statusStyles: Record<ConnectionStatus, string> = {
  connected: 'bg-green/20 text-green',
  connecting: 'bg-yellow/20 text-yellow',
  disconnected: 'bg-red/20 text-red',
};

export default function StatusBadge() {
  const { status } = useEventSource();

  return (
    <span
      class={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusStyles[status()]}`}
    >
      {status()}
    </span>
  );
}
