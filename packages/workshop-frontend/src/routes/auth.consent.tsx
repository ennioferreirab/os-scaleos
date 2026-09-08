import { createFileRoute } from '@tanstack/react-router'
import { ConsentPage } from '../auth/ConsentPage'

export const Route = createFileRoute('/auth/consent')({ component: ConsentPage })
