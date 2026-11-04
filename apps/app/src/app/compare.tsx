import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import CompareScreen from '@/web/screens/compare-screen';

export default function CompareRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Comparer · Cyfouri</title>
        <meta name="robots" content="noindex" />
      </Head>
      <CompareScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
