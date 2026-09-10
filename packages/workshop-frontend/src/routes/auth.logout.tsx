import { createFileRoute } from '@tanstack/react-router'
import { LogoutPage } from '../auth/LogoutPage'

export const Route = createFileRoute('/auth/logout')({ component: LogoutPage })
