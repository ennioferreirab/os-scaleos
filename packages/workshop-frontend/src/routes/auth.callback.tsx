import { createFileRoute } from '@tanstack/react-router'
import { AuthProgressPage } from '../auth/AuthProgressPage'

export const Route = createFileRoute('/auth/callback')({ component: AuthProgressPage })
