import { useLocalSearchParams } from 'expo-router';
import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import DepartementScreen from '@/web/screens/departement-screen';

export default function DepartementRoute() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const screen = useScreen({ level: 'departement', code: code ?? '' });
  return (
    <>
      <Head>
        <title>Département · SquareYield</title>
        <meta name="robots" content="noindex" />
      </Head>
      <DepartementScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
