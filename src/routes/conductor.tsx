import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/conductor')({
  beforeLoad: function redirectConductorRoute() {
    throw redirect({
      to: '/workspace',
      replace: true,
    })
  },
})
