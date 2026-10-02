// Synthetic local HTTP crash fixture. Configuration arrives only from its parent test.
import {createGameServer} from '../../server/app.mjs';
process.once('message',async({database,endpoint,seeds})=>{
 try{
  const app=createGameServer({database,seeds,residentTurnOptions:{initializeJournal:true,provider:{endpoint,model:'synthetic-crash'}}});
  const address=await app.listen(0);process.send({port:address.port});
 }catch(error){process.send({error:error.code??'FIXTURE_FAILED'});process.exitCode=1;}
});
