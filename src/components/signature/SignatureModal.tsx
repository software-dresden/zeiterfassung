'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { SignaturePad } from '@/components/signature/SignaturePad';
import { formatAE, minutesToHHMM } from '@/lib/ae';
import { formatEntryDate } from '@/lib/export';
import { formatKm, formatMaterialLine, hasMaterials, hasTravel } from '@/lib/materials';
import { TimeEntry } from '@/types';

export interface CapturedSignatures {
  technician: string | null;
  customer: string | null;
}

interface SignatureModalProps {
  entry: TimeEntry;
  customerName: string;
  sessionTypeLabel: string;
  technicianName: string;
  /** Called once with the captured signatures, or null if everything was skipped. */
  onFinish: (signatures: CapturedSignatures | null) => void;
}

type Step = 'overview' | 'technician' | 'customer';

const formatClock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

const DetailRow = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
    <dt className="w-32 shrink-0 text-sm text-text-muted">{label}</dt>
    <dd className="min-w-0 text-sm text-text">{children}</dd>
  </div>
);

export const SignatureModal = ({
  entry,
  customerName,
  sessionTypeLabel,
  technicianName,
  onFinish,
}: SignatureModalProps) => {
  const [step, setStep] = useState<Step>('overview');
  const [technicianSignature, setTechnicianSignature] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  const date = formatEntryDate(entry);
  const recap = `${customerName} · ${date} · ${formatAE(entry.duration_minutes)}`;

  const finish = (technician: string | null, customer: string | null) => {
    onFinish(technician || customer ? { technician, customer } : null);
  };

  // The pad remounts for every step (key), so `current` always starts empty.
  const goToCustomer = (technician: string | null) => {
    setTechnicianSignature(technician);
    setCurrent(null);
    setStep('customer');
  };

  const titles: Record<Step, string> = {
    overview: 'Übersicht: bitte prüfen',
    technician: 'Unterschrift Techniker',
    customer: 'Unterschrift Kunde',
  };
  const stepNumber = { overview: 1, technician: 2, customer: 3 }[step];

  return (
    // Not dismissible: a finger drag that ends on the backdrop must not throw the signature away.
    <Modal open onClose={() => finish(null, null)} title={titles[step]} dismissible={false}>
      <p className="-mt-2 mb-4 text-xs text-text-muted">Schritt {stepNumber} von 3</p>

      {step === 'overview' && (
        <>
          <dl className="mb-4 flex flex-col gap-2.5">
            <DetailRow label="Kunde">
              <span className="font-semibold">{customerName}</span>
            </DetailRow>
            <DetailRow label="Datum">{date}</DetailRow>
            {entry.started_at && entry.ended_at && (
              <DetailRow label="Beginn / Ende">
                {formatClock(entry.started_at)} – {formatClock(entry.ended_at)} Uhr
              </DetailRow>
            )}
            <DetailRow label="Session-Typ">{sessionTypeLabel}</DetailRow>
            <DetailRow label="Dauer">
              <span className="font-bold">{formatAE(entry.duration_minutes)}</span>{' '}
              <span className="text-text-muted">({minutesToHHMM(entry.duration_minutes)})</span>
            </DetailRow>
            {hasTravel(entry) && (
              <DetailRow label="Fahrt">{formatKm(entry.travel_km as number)}</DetailRow>
            )}
            {hasMaterials(entry) && (
              <DetailRow label="Material">
                <ul className="flex flex-col gap-0.5">
                  {(entry.materials ?? []).map((item, index) => (
                    <li key={`${item.name}-${index}`} className="break-words">
                      {formatMaterialLine(item)}
                    </li>
                  ))}
                </ul>
              </DetailRow>
            )}
            <DetailRow label="Techniker">{technicianName}</DetailRow>
          </dl>

          <p className="mb-1 text-sm text-text-muted">Notizen / Beschreibung</p>
          <div className="mb-5 max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-text">
            {entry.notes?.trim() ? entry.notes : <span className="text-text-muted">Keine Notizen</span>}
          </div>

          <div className="flex gap-2">
            <Button fullWidth onClick={() => setStep('technician')}>
              Weiter zur Unterschrift
            </Button>
            <Button variant="secondary" onClick={() => finish(null, null)}>
              Überspringen
            </Button>
          </div>
        </>
      )}

      {step === 'technician' && (
        <>
          <p className="mb-3 truncate text-sm text-text-muted" title={recap}>
            {recap}
          </p>
          <p className="mb-2 text-sm text-text">
            Techniker: <span className="font-semibold">{technicianName}</span>
          </p>
          <SignaturePad key="technician" ariaLabel="Unterschrift Techniker" onChange={setCurrent} />
          <div className="mt-4 flex gap-2">
            <Button fullWidth onClick={() => goToCustomer(current)}>
              Weiter
            </Button>
            <Button variant="secondary" onClick={() => goToCustomer(null)}>
              Überspringen
            </Button>
          </div>
        </>
      )}

      {step === 'customer' && (
        <>
          <p className="mb-3 truncate text-sm text-text-muted" title={recap}>
            {recap}
          </p>
          <p className="mb-2 text-sm text-text">
            Kunde: <span className="font-semibold">{customerName}</span>
          </p>
          <SignaturePad key="customer" ariaLabel="Unterschrift Kunde" onChange={setCurrent} />
          <div className="mt-4 flex gap-2">
            <Button fullWidth onClick={() => finish(technicianSignature, current)}>
              Fertig
            </Button>
            <Button variant="secondary" onClick={() => finish(technicianSignature, null)}>
              Überspringen
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
};
