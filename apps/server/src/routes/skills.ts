import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { record } from '../providers/types.js';
import { SkillError, deleteSkill, getSkill, listSkills, parseSkill, saveSkill, searchSkills, version } from '../skills/store.js';

export function registerSkills(app: FastifyInstance, db: DatabaseSync) {
  app.get('/api/skills', async request => ({ skills:listSkills(db,request.userId) }));
  app.post('/api/skills', async (request,reply) => reply.code(201).send(saveSkill(db,request.userId,parseSkill(request.body))));
  app.get<{ Querystring:{ q:string } }>('/api/skills/search', { schema:{ querystring:{ type:'object',additionalProperties:false,required:['q'],properties:{ q:{ type:'string',minLength:1,maxLength:200,pattern:'\\S' } } } } },
    async request=>searchSkills(listSkills(db,request.userId),request.query.q));
  app.get<{ Params:{ id:string } }>('/api/skills/:id',async request=>getSkill(db,request.userId,request.params.id));
  app.put<{ Params:{ id:string } }>('/api/skills/:id',async request=>{
    if (!record(request.body) || Object.keys(request.body).some(key=>!['skill','expectedVersion'].includes(key))) throw new SkillError('保存技能参数无效');
    return saveSkill(db,request.userId,parseSkill(request.body.skill),request.params.id,version(request.body.expectedVersion));
  });
  app.delete<{ Params:{ id:string } }>('/api/skills/:id',async request=>{
    if (!record(request.body) || Object.keys(request.body).some(key=>key!=='expectedVersion')) throw new SkillError('删除技能参数无效');
    deleteSkill(db,request.userId,request.params.id,version(request.body.expectedVersion));return { ok:true };
  });
}
