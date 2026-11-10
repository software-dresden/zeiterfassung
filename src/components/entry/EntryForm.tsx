'use client';

import { useState } from 'react';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { DatePicker } from '@/components/ui/DatePicker';
import { AEInput } from './AEInput';
import { useCustomers } from '@/hooks/useCustomers';
import { useSessionTypes } from '@/hooks/useSessionTypes';

export interface EntryFormValues {
  customer_id: string;
  session_type_id: string;
  entry_date: string;
  /** Set (and > entry_date) when the work spanned several days: one entry from entry_date to end_date. */
  end_date?: string | null;
  duration_minutes: number;
  notes: string;
}

interface EntryFormProps {
  initialValues?: Partial<EntryFormValues>;
  onSubmit: (values: EntryFormValues) => void | Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
  /** Offers a date range (work spread over several days, still one entry). */
  allowRange?: boolean;
}

const todayDateString = (): string => {
  const d = new Date();
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const EntryForm = ({
  initialValues,
  onSubmit,
  onCancel,
  submitLabel = 'Eintrag speichern',
  allowRange = false,
}: EntryFormProps) => {
  const { activeCustomers } = useCustomers();
  const { sessionTypes } = useSessionTypes();

  const [customerId, setCustomerId] = useState(initialValues?.customer_id ?? '');
  const [sessionTypeId, setSessionTypeId] = useState(initialValues?.session_type_id ?? '');
  const [entryDate, setEntryDate] = useState(initialValues?.entry_date ?? todayDateString());
  const [isRange, setIsRange] = useState(!!initialValues?.end_date);
  const [endDate, setEndDate] = useState(initialValues?.end_date ?? initialValues?.entry_date ?? todayDateString());
  const [durationMinutes, setDurationMinutes] = useState(initialValues?.duration_minutes ?? 0);
  const [notes, setNotes] = useState(initialValues?.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!customerId) newErrors.customer_id = 'Kunde ist erforderlich';
    if (!sessionTypeId) newErrors.session_type_id = 'Session-Typ ist erforderlich';
    if (!entryDate) newErrors.entry_date = 'Datum ist erforderlich';
    if (!durationMinutes || durationMinutes <= 0) newErrors.duration = 'Dauer ist erforderlich';
    if (isRange && entryDate && endDate < entryDate) newErrors.end_date = 'Das Enddatum liegt vor dem Startdatum';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    await onSubmit({
      customer_id: customerId,
      session_type_id: sessionTypeId,
      entry_date: entryDate,
      end_date: isRange && endDate > entryDate ? endDate : null,
      duration_minutes: durationMinutes,
      notes,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Select
        label="Kunde *"
        value={customerId}
        onChange={(e) => setCustomerId(e.target.value)}
        error={errors.customer_id}
        fullWidth
      >
        <option value="">Kunde wählen...</option>
        {activeCustomers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>

      <Select
        label="Session-Typ *"
        value={sessionTypeId}
        onChange={(e) => setSessionTypeId(e.target.value)}
        error={errors.session_type_id}
        fullWidth
      >
        <option value="">Typ wählen...</option>
        {sessionTypes.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </Select>

      <div>
        <label className="mb-1 block text-sm text-text-muted">{isRange ? 'Von *' : 'Datum *'}</label>
        <DatePicker
          value={entryDate}
          onChange={(v) => {
            setEntryDate(v);
            if (endDate < v) setEndDate(v);
          }}
        />
        {errors.entry_date && <p className="mt-1 text-xs text-danger">{errors.entry_date}</p>}
      </div>

      {allowRange && (
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={isRange}
            onChange={(e) => {
              setIsRange(e.target.checked);
              if (e.target.checked && endDate < entryDate) setEndDate(entryDate);
            }}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          Über mehrere Tage (Zeitraum)
        </label>
      )}

      {allowRange && isRange && (
        <>
          <div>
            <label className="mb-1 block text-sm text-text-muted">Bis *</label>
            <DatePicker value={endDate} onChange={setEndDate} />
            {errors.end_date && <p className="mt-1 text-xs text-danger">{errors.end_date}</p>}
          </div>
        </>
      )}

      <AEInput minutes={durationMinutes} onChange={setDurationMinutes} />
      {allowRange && isRange && (
        <p className="-mt-2 text-xs text-text-muted">
          Gesamtdauer für den ganzen Zeitraum. Es wird ein einziger Eintrag angelegt.
        </p>
      )}
      {errors.duration && <p className="-mt-3 text-xs text-danger">{errors.duration}</p>}

      <div>
        <label className="mb-1 block text-sm text-text-muted">
          Notizen / Beschreibung{' '}
          <span className="text-text-muted">(erscheint auf der Abrechnung)</span>
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          className="w-full rounded-xl border border-border bg-surface px-4 py-2.5 text-base text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" fullWidth={!onCancel}>
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Abbrechen
          </Button>
        )}
      </div>
    </form>
  );
};
