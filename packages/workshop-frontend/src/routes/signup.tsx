import { createFileRoute } from '@tanstack/react-router'
import { useRpcStub } from '../RpcContext'
import { CF_ACCESS_MODE } from '../useAuth'
import { Navigate } from '@tanstack/react-router'
import SignupPage from '../SignupPage'
import { hasPublicAuthConfig } from '../auth/supabase'

export const Route = createFileRoute('/signup')({
  component: SignupRoute,
})

function SignupRoute() {
  const rpcStub = useRpcStub()
  // Signup is not available in CF Access mode — identity is managed by Access.
  if (hasPublicAuthConfig()) {
    return <Navigate to="/auth/central" replace />
  }
  if (CF_ACCESS_MODE) {
    return <Navigate to="/" replace />
  }
  return <SignupPage rpcStub={rpcStub} />
}
