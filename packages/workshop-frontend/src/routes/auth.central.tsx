import { createFileRoute } from '@tanstack/react-router'
import { CentralAuthPage } from '../auth/CentralAuthPage'

export const Route = createFileRoute('/auth/central')({ component: CentralAuthPage })
