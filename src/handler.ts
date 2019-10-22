import { Context } from 'probot'
import { includesSkipKeywords } from './util'
import { Team } from './team'
import { Assigner } from './assigner'

interface AppConfig {
  teamMembers?: string[]
  skipKeywords?: string[]
}

export class Handler {

  public async handlePullRequest(context: Context, firestore: FirebaseFirestore.Firestore): Promise<void> {
    const config: AppConfig | null = await context.config<AppConfig | null>('auto_assign.yml')

    if (!config) {
      throw new Error('the configuration file failed to load')
    }

    const payload = context.payload
    const labels = payload.pull_request.labels
    if (config.skipKeywords && includesSkipKeywords(labels, config.skipKeywords)) {
      context.log('skips adding reviewers')
      return
    }
    let repo: string = this.getUUID(context.payload.repository.html_url)
    var dbTeam: string[] = await firestore.collection(`repositories`).doc(repo).get().then((snapshot) => {
      if (snapshot.exists && snapshot.data().team) {
        return snapshot.data().team
      } else {
        return []
      }
    });
    console.log(dbTeam)
    var team: Team<string> = this.checkTeamConfig(config.teamMembers, dbTeam);
    let listAssignees = payload.pull_request.assignees
    let oneAssigne = payload.pull_request.assignee
    if (listAssignees.length > 0) {
      // move assignees to the bottom of the queue and dont asiggn new
      
      listAssignees.forEach((assignee: { login: string; }) => {
        console.log(assignee.login)
        team.toBack(assignee.login);
      });
    } else if (oneAssigne && oneAssigne.length > 0) {
      team.toBack(oneAssigne.login)
    } else {
      // check and assign new
      const assigner = new Assigner(context)
      assigner.assignPR(team)
      team.proceed()
    }

    await firestore.collection(`repositories/`).doc(repo).set({ "team": team.toArray() })
  }

  private getUUID(repo: string) {
    return encodeURIComponent(repo)
  }

  private checkTeamConfig(configTeam: string[], dbTeam: string[]): Team<string> {
    let team = new Team<string>(dbTeam ? dbTeam : configTeam)
    if (!configTeam || !dbTeam) {
      return team;
    }
    const dbSet = new Set(dbTeam);
    const configSet = new Set(configTeam)
    configTeam.forEach(member => {
      if (!dbSet.has(member)) {
        console.log("Team member ${member} added! ")
        team.append(member)
      }
    })

    dbSet.forEach(member => {
      if (!configSet.has(member)) {
        console.log("Team member ${member} removed! ")
        team.remove(member)
      }
    })

    return team;
  }


}