import { Title } from '@solidjs/meta';
import { useParams } from '@solidjs/router';

export default function AgentDetail() {
  const params = useParams();

  return (
    <>
      <Title>OmniClaw — Agent Detail</Title>
      <div class="p-4 text-text-dim">Agent Detail: {params.id}</div>
    </>
  );
}
