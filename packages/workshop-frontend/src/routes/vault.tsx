import { createFileRoute } from '@tanstack/react-router'
import { useDocumentTitle } from '../useDocumentTitle'
import { useLocale } from '../i18n'
import VaultCanvas from '../components/VaultCanvas'

export const Route = createFileRoute('/vault')({
  component: VaultRoute,
})

function VaultRoute() {
  const { t } = useLocale()
  useDocumentTitle(t('navigation.vault'))
  return <VaultCanvas />
}
