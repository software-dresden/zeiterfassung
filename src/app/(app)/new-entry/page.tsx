'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EntryForm, EntryFormValues } from '@/components/entry/EntryForm';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useTimeEntries } from '@/hooks/useTimeEntries';

export default function NewEntryPage() {
  const { addEntry } = useTimeEntries();
  const { showToast } = useToast();
  const router = useRouter();

  const [justSaved, setJustSaved] = useState(false);
  const [lastValues, setLastValues] = useState<{ customer_id: string; session_type_id: string } | null>(
    null
  );
  const [formKey, setFormKey] = useState(0);

  const handleSubmit = async (values: EntryFormValues) => {
    await addEntry({
      customer_id: values.customer_id,
      session_type_id: values.session_type_id,
      duration_minutes: values.duration_minutes,
      notes: values.notes || null,
      entry_date: values.entry_date,
      end_date: values.end_date,
    });
    setLastValues({ customer_id: values.customer_id, session_type_id: values.session_type_id });
    setJustSaved(true);
    showToast('Eintrag gespeichert', 'success');
  };

  const handleAnother = () => {
    setJustSaved(false);
    setFormKey((k) => k + 1);
  };

  return (
    <div className="max-w-lg">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
        Arbeit nachtragen
      </p>
      <h1 className="mb-6 text-3xl font-bold tracking-tight text-text">Neue Erfassung</h1>

      <div className="rounded-3xl border border-border bg-surface p-6">
        {justSaved ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text">Eintrag wurde gespeichert.</p>
            <div className="flex gap-2">
              <Button onClick={handleAnother}>Weiteren erfassen</Button>
              <Button variant="secondary" onClick={() => router.push('/sessions')}>
                Zu den Sessions
              </Button>
            </div>
          </div>
        ) : (
          <EntryForm
            key={formKey}
            initialValues={lastValues ?? undefined}
            onSubmit={handleSubmit}
            submitLabel="Eintrag speichern"
            allowRange
          />
        )}
      </div>
    </div>
  );
}
