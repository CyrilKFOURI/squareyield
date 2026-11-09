// Numbered steps of a path (docs/features/017-guided-levels/spec.md): Marché ① France · ② Département ·
// ③ Commune, Investir ① Trouver · ② Analyser · ③ Simuler. Reached steps are links, the next ones say what to do.
// Marché ② and ③ are dropdown pickers (docs/features/020-sidebar-filters/spec.md, design item 2).
import { Fragment, type ReactNode } from 'react';

import { areaLabel, pickerType, typeQuery } from '../../data/level-picker';
import { LevelPicker } from './level-picker';
import { type Navigate, NavLink } from './shell';

export type Step = {
  /** Step name: "France", "Département"… */
  label: string;
  /** What is selected at this step ("Gironde (33)"), or what to do to reach it. */
  value?: string;
  href?: string;
};

type StepState = 'current' | 'done' | 'todo';

/** Chevron between two segments of the bar. */
const StepSep = () => (
  <span className="cy-step-sep" aria-hidden>
    <svg width="7" height="12" viewBox="0 0 7 12" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1 1l5 5-5 5" />
    </svg>
  </span>
);

const StepBody = ({ n, step }: { n?: number; step: Step }) => (
  <>
    {n != null && <b>{n}</b>}
    <span>
      <small>{step.label}</small>
      <em>{step.value ?? '—'}</em>
    </span>
  </>
);

/** One plain segment: a link back when reached, else the current step or what comes next. */
const StepItem = ({ n, step, state, navigate }: { n?: number; step: Step; state: StepState; navigate: Navigate }) =>
  step.href && state !== 'current' ? (
    <NavLink href={step.href} navigate={navigate} className={`cy-step ${state}`}>
      <StepBody n={n} step={step} />
    </NavLink>
  ) : (
    <div className={`cy-step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
      <StepBody n={n} step={step} />
    </div>
  );

const stateOf = (n: number, current: number, sub: boolean): StepState =>
  n === current && !sub ? 'current' : n <= current ? 'done' : 'todo';

/** A page below the current step (a sale under its commune): the step stays reachable, the sub-step is current. */
const SubStep = ({ step }: { step: Step }) => (
  <>
    <StepSep />
    <div className="cy-step current sub" aria-current="step">
      <StepBody step={step} />
    </div>
  </>
);

/** `sub`: a page below the current step (a sale under its commune): the step becomes a link back, the sub-step is current. */
export const Steps = ({
  steps,
  current,
  navigate,
  hint,
  sub,
}: {
  steps: Step[];
  current: number;
  navigate: Navigate;
  hint?: ReactNode;
  sub?: Step;
}) => (
  <nav className="cy-steps" aria-label="Étapes">
    {steps.map((step, i) => (
      <Fragment key={step.label}>
        {i > 0 && <StepSep />}
        <StepItem n={i + 1} step={step} state={stateOf(i + 1, current, Boolean(sub))} navigate={navigate} />
      </Fragment>
    ))}
    {sub && <SubStep step={sub} />}
    {hint && <div className="cy-step-hint">{hint}</div>}
  </nav>
);

type Area = { code: string; name: string };

/** Marché path: France, then the département, then the commune (or arrondissement), each picked from a list. */
export const MarketSteps = ({
  departement,
  commune,
  type,
  navigate,
  sub,
}: {
  departement?: Area | null;
  commune?: (Area & { level: 'commune' | 'arrondissement' }) | null;
  type?: string;
  navigate: Navigate;
  /** A page under the commune (a sale sheet). */
  sub?: Step;
}) => {
  const query = typeQuery(type);
  const dwelling = pickerType(type);
  const current = commune ? 3 : departement ? 2 : 1;
  const hint = current === 1 ? 'Cliquez un département sur la carte, les barres ou le tableau.' : current === 2 ? 'Cliquez une commune pour l’ouvrir.' : null;
  const state = (n: number) => stateOf(n, current, Boolean(sub));
  return (
    <nav className="cy-steps" aria-label="Étapes">
      <StepItem n={1} step={{ label: 'France', value: 'Tous les départements', href: `/${query}` }} state={state(1)} navigate={navigate} />
      <StepSep />
      <LevelPicker
        kind="departement"
        step={2}
        label="Département"
        value={departement ? areaLabel(departement) : 'Choisir un département'}
        state={state(2)}
        here={current === 2 && !sub}
        currentCode={departement?.code}
        type={dwelling}
        query={query}
        listLabel="Départements"
        navigate={navigate}
      />
      <StepSep />
      <LevelPicker
        kind="commune"
        dep={departement?.code}
        step={3}
        label="Commune"
        value={commune ? commune.name : departement ? 'Choisir une commune' : 'choisir d’abord un département'}
        state={state(3)}
        here={current === 3 && !sub}
        disabled={!departement}
        currentCode={commune?.code}
        type={dwelling}
        query={query}
        listLabel={departement ? `Communes · ${departement.name}` : 'Communes'}
        navigate={navigate}
      />
      {sub && <SubStep step={sub} />}
      {hint && <div className="cy-step-hint">{hint}</div>}
    </nav>
  );
};

/** Investir path: find a town, analyse a property, simulate the financing. */
export const InvestSteps = ({ current, navigate, hint }: { current: 1 | 2 | 3; navigate: Navigate; hint?: ReactNode }) => (
  <Steps
    navigate={navigate}
    current={current}
    hint={hint}
    steps={[
      { label: 'Trouver une ville', value: 'Filtres et classement', href: '/investir' },
      { label: 'Analyser un bien', value: 'Prix juste, loyer, risques', href: '/property' },
      { label: 'Simuler le financement', value: 'Crédit, fiscalité, revente', href: '/simulator' },
    ]}
  />
);
