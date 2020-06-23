import { Context } from 'probot'
import {getOwner, getTeam, includesSkipKeywords} from './util'
import { Queue } from './queue'
import { Assigner } from './assigner'
import {AppStorage, DataBasePostgreSQL, DataBaseMock, QueueDB} from './dataBase'
import { Pool } from 'generic-pool'
import {Client} from "ts-postgres";

interface AppConfig {
  scope?: string
  teams?: Team[]
  skipKeywords?: string[]
}

export class Handler {

  private _dbMock: AppStorage

  public async handleIssue(context: Context,pool: Pool<Client>): Promise<void> {
    this.doAssign(context, false, pool)
  }

  public async handlePullRequest(context: Context, pool: Pool<Client>): Promise<void> {
    this.doAssign(context, true, pool)
  }

  public async doAssign(context: Context, isPR: Boolean, pool: Pool<Client>): Promise<void> {
    const config: AppConfig | null = await context.config<AppConfig | null>('auto_assign.yml')
    var db: AppStorage = this.getAppStorage(config.scope, pool)
    if (!config) {
      throw new Error('the configuration file failed to load')
    }

    const payload = context.payload
    const labels = isPR ? payload.pull_request.labels : payload.issue.labels
    if (config.skipKeywords && includesSkipKeywords(labels, config.skipKeywords)) {
      context.log('skips adding reviewers')
      return
    }
    let repo: string = this.getUUID(context.payload.repository.html_url)
    let owner = getOwner(context, isPR)
    let ownerConfigTeam = getTeam(owner, config.teams)
    let dbTeamQueue: QueueDB | null = await db.getTeamQueue(repo, ownerConfigTeam.name)

    console.log(dbTeamQueue? dbTeamQueue : "dbQueue not exist yet for the team: " + ownerConfigTeam? ownerConfigTeam.name: "unknown team")
    var teamReviewersQueue: Queue<string> = this.syncTeamConfig(ownerConfigTeam.reviewers, dbTeamQueue? dbTeamQueue.data : null);
    let listAssignees = isPR ? payload.pull_request.assignees : payload.issue.assignees
    let oneAssignee = isPR ? payload.pull_request.assignee : payload.issue.assignee
    if (listAssignees.length > 0) {
      // move assignees to the bottom of the queue and dont assign new
      listAssignees.forEach((assignee: { login: string; }) => {
        console.log(assignee.login)
        teamReviewersQueue.toBack(assignee.login);
      });
    } else if (oneAssignee && oneAssignee.length > 0) {
      teamReviewersQueue.toBack(oneAssignee.login)
    } else {
      // check and assign new
      const assigner = new Assigner(context)
      assigner.assign(teamReviewersQueue, isPR)
      teamReviewersQueue.proceed()
    }
    // manage persistence for each repo separately
    db.setTeamQueue(new QueueDB(repo,ownerConfigTeam.name,teamReviewersQueue.toArray()))
  }

  private getUUID(repo: string) {
    return encodeURIComponent(repo)
  }

  // synchronize configTeam with dbTeamQueue witch has the current order
  private syncTeamConfig(configTeamReviewers: string[], dbTeamQueue: string[]): Queue<string> {
    // in the first run we only have configTeamReviewers
    let queue = new Queue<string>(dbTeamQueue ? dbTeamQueue : configTeamReviewers)
    if (!configTeamReviewers || !dbTeamQueue) {
      return queue;
    }
    // when we have both, we will use dbTeamQueue order and the list of reviewers from config
    const dbSet = new Set(dbTeamQueue)
    const configSet = new Set(configTeamReviewers)
    configTeamReviewers.forEach(member => {
      if (!dbSet.has(member)) {
        console.log("Team member ${member} added! ")
        queue.append(member)
      }
    })

    dbSet.forEach(member => {
      if (!configSet.has(member)) {
        console.log("Team member ${member} removed! ")
        queue.remove(member)
      }
    })
    return queue;
  }

  private getAppStorage(scope: string, pool: Pool<Client>): AppStorage{
    if (scope === 'dev') {
      if (!this._dbMock){
        this._dbMock = new DataBaseMock()
      }
      return this._dbMock
    } else{
      return new DataBasePostgreSQL(pool)
    }
  }
}

export class Team {
  name: string
  members: string[]
  reviewers: string[]
}