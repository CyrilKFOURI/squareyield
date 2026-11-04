import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import ExplorerScreen from '@/web/screens/explorer-screen';

export default function ExplorerRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Explorer · Cyfouri</title>
        <meta name="robots" content="noindex" />
      </Head>
      <ExplorerScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
