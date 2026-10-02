// Real Store.db subprocess fixture. No provider, credentials, HTTP or movement.
import {appendFileSync} from 'node:fs';
import {initializeHostTurnJournal, createHostTurnJournal} from '../../../server/host-turn-journal.mjs';
import {Store} from '../../../server/store.mjs';
import {terminal} from '../helpers.mjs';

let store, journal, adapter;
process.on('message', async message => {
  try {
    if (message.command === 'open') {
      store = new Store(message.filename);
      initializeHostTurnJournal({database:store.db, ...message.options});
      journal = createHostTurnJournal({database:store.db, ...message.options});
      adapter = journal.forActor({actorId:message.key.actorId, authorize:() => true});
      process.send({event:'ready'});
    } else if (message.command === 'claim') {
      const outcome = adapter.claim(message.key);
      // A local marker records which worker may start synthetic subsequent work.
      // This is not evidence that any provider request or movement was executed.
      if (outcome.status === 'new' && message.marker) appendFileSync(message.marker, `${process.pid}\n`);
      process.send({event:'claimed', outcome});
    } else if (message.command === 'finish') {
      const saved = adapter.finish({...message.key, result:message.result ?? terminal()});
      process.send({event:'finished', saved});
    } else if (message.command === 'close') {
      journal.close(); store.close(); process.send({event:'closed'}, () => process.exit(0));
    }
  } catch (error) { process.send({event:'error', code:error.code ?? 'UNEXPECTED_FIXTURE_ERROR'}); }
});
