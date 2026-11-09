import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import ExplorerScreen from '@/web/screens/explorer-screen';

export default function InvestRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Trouver où investir · SquareYield</title>
        <meta name="robots" content="noindex" />
      </Head>
      <ExplorerScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
