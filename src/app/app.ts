import { Component, ChangeDetectionStrategy } from '@angular/core';
import { SurveyPlanner } from './survey-planner';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SurveyPlanner],
  template: '<app-survey-planner />',
})
export class App {}
