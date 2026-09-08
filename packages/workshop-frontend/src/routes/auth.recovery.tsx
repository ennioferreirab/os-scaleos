import { createFileRoute } from '@tanstack/react-router'
import { RecoveryPage } from '../auth/RecoveryPage'

export const Route = createFileRoute('/auth/recovery')({ component: RecoveryPage })
