import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import SaleScreen from '@/web/screens/sale-screen';

// One past sale (019): individual DVF data, never indexed (DVF terms).
export default function SaleRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Vente · SquareYield</title>
        <meta name="robots" content="noindex" />
      </Head>
      <SaleScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
