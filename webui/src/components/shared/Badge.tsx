import type { JSX } from 'solid-js';

type BadgeVariant =
  | 'default'
  | 'apple-container'
  | 'docker'
  | 'admin'
  | 'active'
  | 'paused'
  | 'completed'
  | 'error'
  | 'remote';

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-surface-2 text-text-dim',
  'apple-container': 'bg-blue/20 text-blue',
  docker: 'bg-cyan/20 text-cyan',
  admin: 'bg-yellow/20 text-yellow',
  active: 'bg-green/20 text-green',
  paused: 'bg-yellow/20 text-yellow',
  completed: 'bg-text-dim/20 text-text-dim',
  error: 'bg-red/20 text-red',
  remote: 'bg-accent/20 text-accent',
};

interface BadgeProps {
  variant?: BadgeVariant;
  children: JSX.Element;
  class?: string;
}

export default function Badge(props: BadgeProps) {
  return (
    <span
      class={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
        variantClasses[props.variant ?? 'default']
      } ${props.class ?? ''}`}
    >
      {props.children}
    </span>
  );
}
