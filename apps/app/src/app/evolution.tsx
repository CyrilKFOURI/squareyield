import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import EvolutionScreen from '@/web/screens/evolution-screen';

export default function EvolutionRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Évolution · Cyfouri</title>
        <meta name="robots" content="noindex" />
      </Head>
      <EvolutionScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
